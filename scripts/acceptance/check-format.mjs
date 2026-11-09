#!/usr/bin/env node
/**
 * Format gate for CI.
 *
 * The frozen Phase 2 baseline contains legacy files that were never formatted
 * with the repository Prettier configuration. Reformatting them would touch
 * business/source files owned by other tasks (and P2-00), so this gate keeps a
 * checked-in debt baseline instead:
 *
 * - Every new or changed file must be Prettier-clean.
 * - Legacy baseline files may remain unformatted until a task owns them.
 * - `--write-baseline` regenerates the debt baseline; it must only be used when
 *   the repository intentionally accepts new formatting debt.
 *
 * The full, debt-inclusive check is still available as `pnpm format:check:all`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = resolve(repoRoot, 'scripts/acceptance/format-baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

function pnpmArgs(args) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli) {
    return {
      command: process.execPath,
      args: [pnpmCli, ...args],
      options: {},
    };
  }
  return {
    command: 'pnpm',
    args,
    options: { shell: process.platform === 'win32' },
  };
}

const prettier = pnpmArgs(['exec', 'prettier', '--list-different', '.']);
const result = run(prettier.command, prettier.args, prettier.options);
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

if (result.status !== 0 && result.status !== 1) {
  console.error('format:check could not run Prettier.');
  if (output) console.error(output);
  process.exit(result.status ?? 1);
}

const unformatted = output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => !line.startsWith('Checking formatting'))
  .filter((line) => !line.startsWith('Code style issues'))
  .map((line) => line.replaceAll('\\', '/'))
  .filter((line) => existsSync(resolve(repoRoot, line)));

if (writeBaseline) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        reason:
          'Legacy formatting debt inherited from the frozen Phase 2 baseline. Remove entries as files are formatted by their owning task.',
        generatedAt: new Date().toISOString(),
        files: unformatted.sort(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`Wrote ${unformatted.length} legacy format entries to ${baselinePath}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const baselineFiles = new Set(baseline.files ?? []);

const baseRef = process.env.CI_FORMAT_BASE_REF?.trim();
const changed = new Set();
if (baseRef && !/^0+$/.test(baseRef)) {
  const verify = run('git', ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  if (verify.status !== 0) {
    console.warn(
      `format:check: cannot resolve CI_FORMAT_BASE_REF=${baseRef}; checking baseline membership only.`,
    );
  } else {
    const diff = run('git', ['diff', '--name-only', `${baseRef}...HEAD`]);
    if (diff.status !== 0) {
      console.warn(
        `format:check: git diff against ${baseRef} failed; checking baseline membership only.`,
      );
    } else {
      for (const file of (diff.stdout ?? '').split(/\r?\n/)) {
        if (file.trim()) changed.add(file.trim().replaceAll('\\', '/'));
      }
    }
  }
}

const regressions = unformatted.filter((file) => !baselineFiles.has(file) || changed.has(file));

if (unformatted.length > 0) {
  console.log(
    `format:check: ${unformatted.length} unformatted file(s); ${baselineFiles.size} are grandfathered legacy debt.`,
  );
}

if (regressions.length > 0) {
  console.error(
    'format:check failed. These files must be formatted (or the baseline must be explicitly regenerated):',
  );
  for (const file of regressions) console.error(`  - ${file}`);
  console.error('Run: pnpm exec prettier --write <file> (only on files owned by your task).');
  process.exit(1);
}

console.log('format:check passed (changed files are Prettier-clean).');
