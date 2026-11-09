#!/usr/bin/env node
/**
 * Cleanup for the protected real CLI workflow. Always runs, but only removes
 * explicitly named test paths and the isolated temporary root. It never touches
 * the repository, the user's worktrees, or another agent's checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(
  process.env.CI_REAL_CLI_ARTIFACT_DIR ?? join(repoRoot, 'ci-artifacts', 'real-cli'),
);
const cleanupDir = join(artifactDir, 'cleanup');
mkdirSync(cleanupDir, { recursive: true });

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function worktreeList() {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (error) {
    return `could not read worktrees: ${error.message}`;
  }
}

const root = process.env.HAFT_REAL_CLI_ROOT ? resolve(process.env.HAFT_REAL_CLI_ROOT) : null;
const runnerTemp = process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP) : null;
const tempBase = runnerTemp && existsSync(runnerTemp) ? runnerTemp : tmpdir();
const rootIsSafe = Boolean(root && !isInside(repoRoot, root) && isInside(tempBase, root));

const repoPaths = [
  'test-results/real-e2e',
  'playwright-report-real',
  'apps/api/prisma/real-e2e.db',
  'apps/api/prisma/real-e2e.db-journal',
  'apps/api/prisma/real-e2e.db-wal',
  'apps/api/prisma/real-e2e.db-shm',
];

const plan = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
  isEphemeralRunner: process.env.HAFT_REAL_CLI_EPHEMERAL === '1',
  root,
  rootIsSafe,
  repoPaths,
  worktreesBefore: worktreeList(),
  note:
    process.env.HAFT_REAL_CLI_EPHEMERAL === '1'
      ? 'Ephemeral VM: the whole runner can be destroyed after this cleanup.'
      : 'Non-ephemeral self-hosted runner: the runner administrator must re-provision or verify the residual state after this cleanup.',
};
writeFileSync(join(cleanupDir, 'cleanup-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

const removed = [];
const missing = [];
const errors = [];

if (root) {
  if (!rootIsSafe) {
    errors.push(`refusing to remove unsafe HAFT_REAL_CLI_ROOT ${root}`);
  } else if (existsSync(root)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(root);
    } catch (error) {
      errors.push(`could not remove ${root}: ${error.message}`);
    }
  } else {
    missing.push(root);
  }
}

for (const path of repoPaths) {
  const full = resolve(repoRoot, path);
  if (!isInside(repoRoot, full)) {
    errors.push(`refusing to remove path outside repository: ${full}`);
    continue;
  }
  if (existsSync(full)) {
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(full);
    } catch (error) {
      errors.push(`could not remove ${full}: ${error.message}`);
    }
  } else {
    missing.push(full);
  }
}

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: errors.length === 0 ? 'CLEAN' : 'ERROR',
  removed,
  missing,
  errors,
  worktreesAfter: worktreeList(),
  repoRootPreserved: true,
  note: 'Only explicit real-e2e test paths and the isolated temporary root are removed.',
};
writeFileSync(join(cleanupDir, 'cleanup.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(
  `real-cli cleanup: ${result.status} removed=${removed.length} missing=${missing.length} errors=${errors.length}`,
);
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
