#!/usr/bin/env node
/**
 * Production dependency audit gate.
 *
 * - High/Critical findings block the job unless a matching, unexpired exemption
 *   exists in scripts/acceptance/audit-exemptions.json.
 * - Moderate/Low findings are always reported in the job summary and artifact.
 * - Audit service failures are infrastructure failures, never a pass.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(
  process.env.CI_SECURITY_ARTIFACT_DIR ?? join(repoRoot, 'ci-artifacts', 'security'),
);
const exemptionPath = join(repoRoot, 'scripts/acceptance/audit-exemptions.json');
const registry = process.env.CI_AUDIT_REGISTRY ?? 'https://registry.npmjs.org';
mkdirSync(artifactDir, { recursive: true });

function pnpmInvocation(args) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli) return { command: process.execPath, args: [pnpmCli, ...args], shell: false };
  return { command: 'pnpm', args, shell: process.platform === 'win32' };
}

function writeSummary(summary, rawOutput) {
  writeFileSync(join(artifactDir, 'audit.json'), rawOutput, 'utf8');
  writeFileSync(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  const lines = [
    '## Dependency security audit',
    '',
    `- Registry: \`${registry}\``,
    `- Generated: ${summary.generatedAt}`,
    `- Status: **${summary.status}**`,
    `- Blocking threshold: **high/critical**`,
    '',
    '| Severity | Count |',
    '| --- | ---: |',
  ];
  for (const severity of ['critical', 'high', 'moderate', 'low', 'info']) {
    lines.push(`| ${severity} | ${summary.counts[severity] ?? 0} |`);
  }
  lines.push('');
  if (summary.advisories.length > 0) {
    lines.push('| Advisory | Module | Severity | Exempt | Note |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const advisory of summary.advisories) {
      lines.push(
        `| ${advisory.url ? `[${advisory.id}](${advisory.url})` : advisory.id} | ${advisory.module} | ${advisory.severity} | ${advisory.exempt ? 'yes' : 'no'} | ${advisory.exemptionReason ?? advisory.title} |`,
      );
    }
    lines.push('');
  }
  if (summary.blocking.length > 0) {
    lines.push(`**Blocking findings:** ${summary.blocking.map((item) => item.id).join(', ')}`);
  } else if (summary.expiredExemptions?.length > 0) {
    lines.push(
      `**Expired exemptions:** ${summary.expiredExemptions.map((item) => item.id).join(', ')}`,
    );
  } else {
    lines.push('No unexempted high/critical findings.');
  }
  if (summary.status === 'BLOCKED') {
    lines.push('');
    lines.push(`**Infrastructure failure:** ${summary.error}`);
  }
  lines.push('');
  const markdown = `${lines.join('\n')}\n`;
  writeFileSync(join(artifactDir, 'summary.md'), markdown, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

let exemptions = [];
if (existsSync(exemptionPath)) {
  try {
    const parsed = JSON.parse(readFileSync(exemptionPath, 'utf8'));
    exemptions = Array.isArray(parsed.exemptions) ? parsed.exemptions : [];
  } catch (error) {
    console.error(`Cannot parse ${exemptionPath}: ${error.message}`);
    process.exit(2);
  }
}

for (const exemption of exemptions) {
  if (!exemption.id || !exemption.reason || !exemption.owner || !exemption.expiresAt) {
    console.error('Every audit exemption must contain id, reason, owner and expiresAt.');
    process.exit(2);
  }
  if (!Number.isFinite(Date.parse(exemption.expiresAt))) {
    console.error(`Audit exemption ${exemption.id} has an invalid expiresAt value.`);
    process.exit(2);
  }
}

const invocation = pnpmInvocation(['audit', '--prod', `--registry=${registry}`, '--json']);
const result = spawnSync(invocation.command, invocation.args, {
  cwd: repoRoot,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
  shell: invocation.shell,
  maxBuffer: 32 * 1024 * 1024,
});
const raw = result.stdout || '';

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'BLOCKED',
    error:
      result.error?.message ||
      result.stderr?.trim() ||
      raw.trim() ||
      'pnpm audit did not return parseable JSON (audit endpoint unavailable?)',
    counts: {},
    advisories: [],
    blocking: [],
  };
  writeSummary(summary, raw || result.stderr || '');
  console.error(`security:audit BLOCKED - ${summary.error}`);
  process.exit(2);
}

if (parsed.error) {
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'BLOCKED',
    error: `${parsed.error.code ?? 'AUDIT_ERROR'}: ${parsed.error.message ?? 'unknown audit error'}`,
    counts: {},
    advisories: [],
    blocking: [],
  };
  writeSummary(summary, raw);
  console.error(`security:audit BLOCKED - ${summary.error}`);
  process.exit(2);
}

const rawAdvisories = Array.isArray(parsed.advisories)
  ? parsed.advisories
  : Object.values(parsed.advisories ?? {});
const now = Date.now();
const advisoryList = [];
const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
const blocking = [];

for (const advisory of rawAdvisories) {
  const severity = String(advisory.severity ?? 'info').toLowerCase();
  counts[severity] = (counts[severity] ?? 0) + 1;
  const exemption = exemptions.find((item) => String(item.id) === String(advisory.id));
  const expired = exemption ? Date.parse(exemption.expiresAt) <= now : false;
  const exempt = Boolean(exemption) && !expired;
  const entry = {
    id: String(advisory.id ?? 'unknown'),
    module: advisory.module_name ?? advisory.module ?? 'unknown',
    severity,
    title: advisory.title ?? '',
    url: advisory.url ?? advisory.github_advisory_id ?? null,
    vulnerableVersions: advisory.vulnerable_versions ?? null,
    patchedVersions: advisory.patched_versions ?? null,
    findings: advisory.findings ?? [],
    exempt,
    exemptionExpired: expired,
    exemptionReason: exemption?.reason ?? null,
    exemptionOwner: exemption?.owner ?? null,
    exemptionExpiresAt: exemption?.expiresAt ?? null,
  };
  advisoryList.push(entry);
  if (!exempt && (severity === 'high' || severity === 'critical')) blocking.push(entry);
}

const expiredExemptions = exemptions.filter((exemption) => Date.parse(exemption.expiresAt) <= now);
for (const exemption of expiredExemptions) {
  console.warn(`security:audit exemption ${exemption.id} expired at ${exemption.expiresAt}`);
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status:
    blocking.length > 0 || expiredExemptions.length > 0
      ? 'FAIL'
      : advisoryList.some((item) => item.exempt && ['high', 'critical'].includes(item.severity))
        ? 'PASS_WITH_EXEMPTIONS'
        : 'PASS',
  registry,
  threshold: 'high/critical',
  counts,
  advisories: advisoryList,
  blocking,
  expiredExemptions,
  exemptions,
  note: 'Moderate/Low findings are reported but do not block. High/Critical require an unexpired, owned exemption; expired exemptions fail the job.',
};
writeSummary(summary, raw);
console.log(
  `security:audit ${summary.status}: critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low} blocking=${blocking.length}`,
);
process.exit(blocking.length > 0 || expiredExemptions.length > 0 ? 1 : 0);
