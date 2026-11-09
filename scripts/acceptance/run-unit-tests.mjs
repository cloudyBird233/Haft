#!/usr/bin/env node
/**
 * Runs every deterministic Vitest layer independently.
 *
 * `pnpm test` stops at the first failing workspace because its script uses
 * `&&`. CI needs a report from every layer even when an earlier layer fails, so
 * this orchestrator runs each package test script, keeps going after a failure,
 * and exits non-zero if any layer failed. It never changes test logic or
 * assertions.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const reportDir = process.env.CI_TEST_REPORT_DIR
  ? resolve(process.env.CI_TEST_REPORT_DIR)
  : join(repoRoot, 'ci-artifacts', 'unit', 'local');

mkdirSync(reportDir, { recursive: true });

const layers = [
  { id: 'contracts', filter: '@raft-lite/contracts', report: 'contracts.json' },
  { id: 'api', filter: '@raft-lite/api', report: 'api.json' },
  { id: 'runner', filter: '@raft-lite/runner', report: 'runner.json' },
  { id: 'web', filter: '@raft-lite/web', report: 'web.json' },
];

function pnpmInvocation(args) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli) {
    return { command: process.execPath, args: [pnpmCli, ...args], shell: false };
  }
  return { command: 'pnpm', args, shell: process.platform === 'win32' };
}

const results = [];
for (const layer of layers) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const invocation = pnpmInvocation(['--filter', layer.filter, 'test']);
  console.log(`\n=== ${layer.id}: pnpm --filter ${layer.filter} test ===`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: { ...process.env, CI_TEST_REPORT_DIR: reportDir },
    stdio: 'inherit',
    shell: invocation.shell,
  });
  results.push({
    id: layer.id,
    command: `pnpm --filter ${layer.filter} test`,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    report: join(reportDir, layer.report),
    reportExpected: true,
  });
}

const orchestration = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  reportDir,
  layers: results,
  failed: results.filter((layer) => layer.exitCode !== 0).map((layer) => layer.id),
};
writeFileSync(
  join(reportDir, 'orchestration.json'),
  `${JSON.stringify(orchestration, null, 2)}\n`,
  'utf8',
);

console.log('\n=== deterministic test orchestration ===');
for (const layer of results) {
  console.log(`${layer.id}: ${layer.exitCode === 0 ? 'PASS' : 'FAIL'} (${layer.durationMs} ms)`);
}

process.exit(results.some((layer) => layer.exitCode !== 0) ? 1 : 0);
