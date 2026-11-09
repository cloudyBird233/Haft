#!/usr/bin/env node
/**
 * Converts the protected real CLI Playwright JSON report into a verdict and a
 * redacted evidence manifest. A skipped required Codex test is never a PASS.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(
  process.env.CI_REAL_CLI_ARTIFACT_DIR ?? join(repoRoot, 'ci-artifacts', 'real-cli'),
);
mkdirSync(artifactDir, { recursive: true });

const API_TEST = 'runs a real Codex CLI in an isolated worktree';
const UI_TEST =
  'creates data in the UI, runs the real CLI, and shows the diff without touching the primary checkout';
const OPENCODE_TEST = 'runs a real OpenCode CLI in an isolated worktree';

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function findReport() {
  return (
    walkFiles(artifactDir).find((file) => file.split(/[\\/]/).pop() === 'playwright.json') ?? null
  );
}

function collectTests(suite, out) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      out.push({
        title: spec.title ?? 'untitled',
        file: suite.file ?? null,
        project: test.projectName ?? null,
        status: test.status ?? 'unknown',
        retries: Math.max(0, (test.results ?? []).length - 1),
        durationMs: (test.results ?? []).reduce(
          (sum, result) => sum + Number(result.duration ?? 0),
          0,
        ),
      });
    }
  }
  for (const child of suite.suites ?? []) collectTests(child, out);
}

function matchTest(tests, title) {
  return (
    tests.find((test) => test.title === title) ??
    tests.find((test) => test.title.includes(title)) ??
    null
  );
}

function verdictFor(test) {
  if (!test) return 'MISSING';
  if (test.status === 'expected') return 'PASS';
  if (test.status === 'skipped') return 'SKIPPED';
  if (test.status === 'flaky') return 'FAIL_FLAKY';
  return 'FAIL';
}

const reportFile = findReport();
let report = null;
let tests = [];
if (reportFile) {
  report = JSON.parse(readFileSync(reportFile, 'utf8'));
  for (const suite of report.suites ?? []) collectTests(suite, tests);
}

const preflightFile = join(artifactDir, 'preflight.json');
let preflight = null;
if (existsSync(preflightFile)) {
  try {
    preflight = JSON.parse(readFileSync(preflightFile, 'utf8'));
  } catch {
    preflight = null;
  }
}
const checkDetail = (name) =>
  preflight?.checks?.find((check) => check.name === name && check.ok)?.detail ?? null;

const codexApi = matchTest(tests, API_TEST);
const codexUi = matchTest(tests, UI_TEST);
const opencode = matchTest(tests, OPENCODE_TEST);
const codexApiVerdict = verdictFor(codexApi);
const codexUiVerdict = verdictFor(codexUi);
const opencodeVerdict = verdictFor(opencode);

const requiredPassed = codexApiVerdict === 'PASS' && codexUiVerdict === 'PASS';
const optionalFailed = process.env.HAFT_REAL_E2E_OPENCODE === '1' && opencodeVerdict !== 'PASS';
const failedTests = tests.filter((test) => !['expected', 'skipped'].includes(test.status));

let status = 'PASS';
let reason = 'Required Codex API and Codex UI real CLI tests passed.';
if (!report) {
  status = 'BLOCKED';
  reason = 'Playwright JSON report is missing; no real CLI evidence exists.';
} else if (preflight?.status !== 'PASS') {
  status = 'BLOCKED';
  reason = `Preflight evidence is missing or not PASS (status=${preflight?.status ?? 'MISSING'}).`;
} else if (codexApiVerdict === 'MISSING' || codexUiVerdict === 'MISSING') {
  status = 'BLOCKED';
  reason = `Required Codex test evidence is missing (API=${codexApiVerdict}, UI=${codexUiVerdict}).`;
} else if (!requiredPassed) {
  status = 'FAIL';
  reason = `Required Codex tests did not both pass (API=${codexApiVerdict}, UI=${codexUiVerdict}).`;
} else if (optionalFailed || failedTests.length > 0) {
  status = 'FAIL';
  reason = 'At least one executed real CLI test failed.';
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status,
  reason,
  commit: process.env.HAFT_REAL_CLI_COMMIT ?? process.env.GITHUB_SHA ?? preflight?.commit ?? null,
  workflow: {
    name: process.env.GITHUB_WORKFLOW ?? 'real-cli',
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    url:
      process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
        ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
  },
  environment: {
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? preflight?.runner?.environment ?? null,
    runnerName: process.env.RUNNER_NAME ?? preflight?.runner?.name ?? null,
    runnerOs: process.env.RUNNER_OS ?? preflight?.runner?.os ?? null,
    imageOs: process.env.ImageOS ?? null,
    node: process.version,
    codexVersion: checkDetail('codex-version') ?? process.env.HAFT_CODEX_VERSION ?? null,
    codexBinarySha256:
      checkDetail('codex-binary-sha256') ?? process.env.HAFT_CODEX_BIN_SHA256 ?? null,
    codexHomeIsolated: Boolean(checkDetail('isolated-codex-home') || process.env.CODEX_HOME),
  },
  preflight: preflight
    ? { status: preflight.status ?? null, error: preflight.error ?? null }
    : { status: 'MISSING', error: 'preflight.json was not produced' },
  isolation: {
    environment: 'real-cli',
    selfHostedLabel: 'haft-real-cli-ephemeral',
    codexHome: process.env.CODEX_HOME ? 'isolated' : 'missing',
    credentials: 'environment secret; never copied to test environment or artifacts',
    personalCodexHomeUsed: false,
  },
  command: 'HAFT_REAL_CLI_E2E=1 HAFT_REAL_CLI_REQUIRED=1 pnpm test:e2e:real',
  tests: {
    codexApi: { title: API_TEST, verdict: codexApiVerdict, test: codexApi },
    codexUi: { title: UI_TEST, verdict: codexUiVerdict, test: codexUi },
    opencode: {
      title: OPENCODE_TEST,
      verdict: opencodeVerdict,
      enabled: process.env.HAFT_REAL_E2E_OPENCODE === '1',
      test: opencode,
      note: 'When disabled, SKIPPED is explicitly not a PASS.',
    },
  },
  allTests: tests,
  evidence: {
    playwrightJson: reportFile ? relative(artifactDir, reportFile).replaceAll('\\', '/') : null,
    junit: existsSync(join(artifactDir, 'playwright-junit.xml')) ? 'playwright-junit.xml' : null,
    screenshots: existsSync(join(artifactDir, 'evidence', 'playwright'))
      ? 'evidence/playwright'
      : null,
    gitDiff: existsSync(join(artifactDir, 'evidence', 'diffs')) ? 'evidence/diffs' : null,
    runLog: existsSync(join(artifactDir, 'run.log')) ? 'run.log' : null,
    cleanup: 'cleanup/cleanup.json (uploaded separately after always() cleanup)',
  },
};

writeFileSync(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

const lines = [
  '# Haft real CLI acceptance report',
  '',
  `- Verdict: **${status}**`,
  `- Reason: ${reason}`,
  `- Commit: \`${summary.commit ?? 'unknown'}\``,
  `- Workflow: ${summary.workflow.url ?? 'local/manual'}`,
  `- Runner: ${summary.environment.runnerName ?? 'unknown'} (${summary.environment.runnerEnvironment ?? 'unknown'})`,
  `- Preflight: ${summary.preflight.status}${summary.preflight.error ? ` — ${summary.preflight.error}` : ''}`,
  `- Codex version: \`${summary.environment.codexVersion ?? 'unknown'}\``,
  `- Codex binary SHA256: \`${summary.environment.codexBinarySha256 ?? 'unknown'}\``,
  `- Command: \`${summary.command}\``,
  '',
  '| Required test | Verdict |',
  '| --- | --- |',
  `| Codex API | ${codexApiVerdict} |`,
  `| Codex UI | ${codexUiVerdict} |`,
  `| OpenCode (optional) | ${opencodeVerdict}${opencodeVerdict === 'SKIPPED' ? ' — not a PASS' : ''} |`,
  '',
  '## Isolation',
  '',
  '- Environment: `real-cli` with required reviewers and deployment branch restrictions.',
  '- Runner: self-hosted label `haft-real-cli-ephemeral`; GitHub-hosted runners are not accepted.',
  '- `CODEX_HOME`: isolated directory inside `HAFT_REAL_CLI_ROOT`; personal `~/.codex` is never used.',
  '- Credentials: environment secret, materialized only into the isolated CODEX_HOME and removed by cleanup.',
  '- Test environment: no CLI secret, independent DB/ports/repository/worktree/recovery root.',
  '',
  '## Evidence',
  '',
  '- Native machine-readable report: `playwright.json`',
  '- JUnit: `playwright-junit.xml`',
  '- Screenshots/traces: `evidence/playwright`',
  '- Git status/diff: `evidence/git`, `evidence/diffs`',
  '- Run log: `run.log` (redacted before upload)',
  '- Cleanup record: separate `real-cli-cleanup` artifact',
  '- Manifest and SHA256: `manifest.json`, `sha256.txt`',
  '',
  '> A skipped required test is never counted as PASS. A missing JSON report means BLOCKED.',
  '',
];
writeFileSync(join(artifactDir, 'report.md'), `${lines.join('\n')}\n`, 'utf8');

const manifestFiles = walkFiles(artifactDir)
  .filter((file) => !['manifest.json', 'sha256.txt'].includes(file.split(/[\\/]/).pop() ?? ''))
  .map((file) => {
    const stat = statSync(file);
    return {
      path: relative(artifactDir, file).replaceAll('\\', '/'),
      bytes: stat.size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: summary.commit,
  status,
  files: manifestFiles,
  totalBytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
};
writeFileSync(join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
writeFileSync(
  join(artifactDir, 'sha256.txt'),
  `${manifestFiles.map((file) => `${file.sha256}  ${file.path}`).join('\n')}\n`,
  'utf8',
);

console.log(`real-cli report: ${status} (${reason})`);
process.exit(status === 'PASS' ? 0 : 1);
