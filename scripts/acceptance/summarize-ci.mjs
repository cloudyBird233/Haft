#!/usr/bin/env node
/**
 * Builds machine-readable and human-readable CI test summaries from native
 * Vitest JSON and Playwright JSON reports. Test counts are never hardcoded.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const artifactArg = args.indexOf('--artifacts');
const artifactRoot = resolve(
  artifactArg >= 0 && args[artifactArg + 1]
    ? args[artifactArg + 1]
    : join(repoRoot, 'ci-artifacts'),
);

const UNIT_LAYERS = ['contracts', 'api', 'runner', 'web'];
const EXPECTED_PLATFORMS = ['ubuntu-latest', 'windows-latest'];

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

function pnpmVersion() {
  try {
    return (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).packageManager ?? 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

function commitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function countVitestReport(file) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const assertions = (report.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let flaky = 0;

  if (assertions.length > 0) {
    for (const assertion of assertions) {
      switch (assertion.status) {
        case 'passed':
          passed += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'pending':
        case 'skipped':
        case 'todo':
        case 'disabled':
          skipped += 1;
          break;
        default:
          failed += 1;
      }
    }
  } else {
    passed = Number(report.numPassedTests ?? 0);
    failed = Number(report.numFailedTests ?? 0);
    skipped = Number(report.numPendingTests ?? 0) + Number(report.numTodoTests ?? 0);
    flaky = Number(report.numFlakyTests ?? 0);
  }

  return {
    total: passed + failed + skipped + flaky,
    passed,
    failed,
    skipped,
    flaky,
    success: passed + failed + skipped + flaky > 0 && report.success !== false && failed === 0,
  };
}

function walkPlaywrightSuite(suite, fileName, tests) {
  const currentFile = suite.file ?? fileName ?? suite.title ?? 'unknown';
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const resultStatuses = (test.results ?? []).map((result) => result.status);
      let status = test.status;
      if (!status) {
        status = resultStatuses.includes('failed')
          ? 'unexpected'
          : resultStatuses.includes('skipped')
            ? 'skipped'
            : 'expected';
      }
      tests.push({
        title: spec.title ?? 'untitled',
        fullTitle: [suite.title, spec.title].filter(Boolean).join(' > '),
        file: currentFile,
        project: test.projectName ?? null,
        status,
        retries: Math.max(0, (test.results ?? []).length - 1),
      });
    }
  }
  for (const child of suite.suites ?? []) {
    walkPlaywrightSuite(child, currentFile, tests);
  }
}

function countPlaywrightReport(file) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const tests = [];
  for (const suite of report.suites ?? []) walkPlaywrightSuite(suite, suite.file, tests);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let flaky = 0;
  for (const test of tests) {
    switch (test.status) {
      case 'expected':
        passed += 1;
        break;
      case 'flaky':
        flaky += 1;
        break;
      case 'skipped':
        skipped += 1;
        break;
      default:
        failed += 1;
    }
  }

  const reportErrors = Array.isArray(report.errors) ? report.errors.length : 0;

  return {
    total: passed + failed + skipped + flaky,
    passed,
    failed,
    skipped,
    flaky,
    reportErrors,
    success: tests.length > 0 && failed === 0 && reportErrors === 0,
    tests,
  };
}

const unitReports = walkFiles(join(artifactRoot, 'unit'));
const layers = [];

for (const file of unitReports) {
  const name = file.split(/[\\/]/).pop() ?? '';
  const layer = UNIT_LAYERS.find((candidate) => name === `${candidate}.json`);
  if (!layer) continue;
  const rel = relative(join(artifactRoot, 'unit'), file).replaceAll('\\', '/');
  // download-artifact extracts each `unit-<os>` artifact into its own directory.
  const artifactName = rel.includes('/') ? rel.split('/')[0] : 'unknown';
  const platform = artifactName.replace(/^unit-/, '');
  const counts = countVitestReport(file);
  layers.push({
    id: `unit-${layer}`,
    kind: 'deterministic',
    framework: 'vitest',
    runtime: 'mock + fake-runner integration',
    platform,
    source: `unit/${rel}`,
    ...counts,
  });
}

const e2eReport = walkFiles(join(artifactRoot, 'e2e')).find(
  (file) => file.split(/[\\/]/).pop() === 'playwright.json',
);
if (e2eReport) {
  const counts = countPlaywrightReport(e2eReport);
  layers.push({
    id: 'e2e',
    kind: 'playwright',
    framework: 'playwright',
    runtime: 'fake-runner + deterministic mock',
    platform: process.env.RUNNER_OS ?? 'ubuntu-latest',
    source: `e2e/${relative(join(artifactRoot, 'e2e'), e2eReport).replaceAll('\\', '/')}`,
    ...counts,
  });
}

const expectedLayers = [
  ...EXPECTED_PLATFORMS.flatMap((platform) =>
    UNIT_LAYERS.map((layer) => ({ id: `unit-${layer}`, platform })),
  ),
  { id: 'e2e', platform: null },
];

const missing = expectedLayers.filter(
  (expected) =>
    !layers.some(
      (layer) =>
        layer.id === expected.id && (!expected.platform || layer.platform === expected.platform),
    ),
);

const totals = layers.reduce(
  (acc, layer) => {
    acc.total += layer.total;
    acc.passed += layer.passed;
    acc.failed += layer.failed;
    acc.skipped += layer.skipped;
    acc.flaky += layer.flaky;
    return acc;
  },
  { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 },
);

let status = 'passed';
if (missing.length > 0) status = 'incomplete';
else if (layers.some((layer) => layer.success === false || layer.failed > 0)) status = 'failed';
else if (totals.total === 0) status = 'empty';

const sha = commitSha();
const repository = process.env.GITHUB_REPOSITORY ?? 'cloudyBird233/Haft';
const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const runId = process.env.GITHUB_RUN_ID ?? '';
const workflowUrl = runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null;
const generatedAt = new Date().toISOString();

const summary = {
  schemaVersion: 1,
  generatedAt,
  commit: {
    sha,
    ref: process.env.GITHUB_REF ?? null,
    repository,
  },
  workflow: {
    name: process.env.GITHUB_WORKFLOW ?? 'CI',
    runId: runId || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    url: workflowUrl,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  },
  environment: {
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerName: process.env.RUNNER_NAME ?? null,
    imageOs: process.env.ImageOS ?? null,
    node: process.version,
    pnpm: pnpmVersion(),
  },
  classifications: {
    deterministic: 'Vitest contracts/API/runner/web suites',
    playwright: 'Playwright deterministic browser suite with Mock Runtime and Fake Runner',
    realCli: 'Separate protected real-cli workflow; never run from pull_request CI',
  },
  status,
  totals,
  layers,
  missing,
  realCli: {
    runInThisWorkflow: false,
    workflow: `.github/workflows/real-cli.yml`,
    note: 'Real Codex CLI acceptance is manual, environment-protected and not part of PR CI.',
  },
};

mkdirSync(artifactRoot, { recursive: true });
writeFileSync(
  join(artifactRoot, 'test-summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
);
writeFileSync(
  join(artifactRoot, 'metadata.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt,
      commitSha: sha,
      ref: process.env.GITHUB_REF ?? null,
      workflow: summary.workflow,
      environment: summary.environment,
      status,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

function statusIcon(layer) {
  if (layer.failed > 0 || layer.success === false) return '❌ failed';
  if (layer.flaky > 0) return '⚠️ flaky';
  if (layer.skipped > 0) return '⚠️ skipped';
  return '✅ passed';
}

const lines = [];
lines.push('## Haft CI test summary');
lines.push('');
lines.push(`- Commit: \`${sha}\``);
if (summary.workflow.url) lines.push(`- Workflow run: ${summary.workflow.url}`);
lines.push(`- Event: \`${summary.workflow.event ?? 'unknown'}\``);
lines.push(`- Generated: ${generatedAt}`);
lines.push(`- Overall: **${status.toUpperCase()}**`);
lines.push('');
lines.push('| Layer | Platform | Kind | Total | Passed | Failed | Skipped | Flaky | Status |');
lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
for (const layer of layers) {
  lines.push(
    `| ${layer.id} | ${layer.platform ?? '—'} | ${layer.kind} | ${layer.total} | ${layer.passed} | ${layer.failed} | ${layer.skipped} | ${layer.flaky} | ${statusIcon(layer)} |`,
  );
}
lines.push(
  `| **Total** | — | — | **${totals.total}** | **${totals.passed}** | **${totals.failed}** | **${totals.skipped}** | **${totals.flaky}** | **${status.toUpperCase()}** |`,
);
lines.push('');
if (missing.length > 0) {
  lines.push('### Missing required reports');
  for (const item of missing) lines.push(`- ${item.id} (${item.platform ?? 'any platform'})`);
  lines.push('');
}
lines.push(
  '> Counts above come from native Vitest/Playwright JSON reports. They are not hardcoded and will change as P2-00 and later tasks add tests.',
);
lines.push(
  '> Real Codex CLI tests are not part of PR CI. They run only through `.github/workflows/real-cli.yml` with `real-cli` environment approval.',
);
lines.push('');

const markdown = `${lines.join('\n')}\n`;
writeFileSync(join(artifactRoot, 'test-summary.md'), markdown, 'utf8');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

console.log(markdown);
console.log(`Wrote ${join(artifactRoot, 'test-summary.json')}`);

process.exit(status === 'passed' ? 0 : 1);
