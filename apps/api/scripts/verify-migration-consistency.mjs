#!/usr/bin/env node
/**
 * Verifies that the committed migration chain reproduces `prisma/schema.prisma`.
 *
 * This script never touches a development, test or production database:
 *
 * 1. it creates a throwaway SQLite file in a temporary directory;
 * 2. it applies the *real* migration chain with `prisma migrate deploy`
 *    (`prisma db push` is deliberately never used, because a pushed schema
 *    proves nothing about the migrations that production actually runs);
 * 3. it diffs that migrated database against the datamodel; a non-empty diff
 *    means somebody edited `schema.prisma` without writing a migration, or
 *    hand-edited a migration into something the datamodel no longer matches.
 *
 * Any difference is a hard failure with a non-zero exit code, so CI and a
 * release checklist can depend on it.
 *
 * Usage: `pnpm --filter @raft-lite/api db:migrate:verify`
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = join(apiRoot, 'prisma', 'schema.prisma');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const prismaEntry = join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js');

function fail(message, detail) {
  process.stderr.write(`verify-migration-consistency: FAIL: ${message}\n`);
  if (detail) process.stderr.write(`${String(detail).trim()}\n`);
  process.exit(1);
}

function prisma(args, databaseUrl) {
  const result = spawnSync(process.execPath, [prismaEntry, ...args], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/** `file:` URL with forward slashes, which SQLite accepts on every platform. */
function sqliteUrl(absolutePath) {
  return `file:${absolutePath.replace(/\\/g, '/')}`;
}

const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (migrations.length === 0) {
  fail(`no migration directories found in ${migrationsDir}`);
}

const scratchDir = mkdtempSync(join(tmpdir(), 'haft-migration-verify-'));
const databasePath = join(scratchDir, 'verify.db');
const databaseUrl = sqliteUrl(databasePath);

try {
  mkdirSync(scratchDir, { recursive: true });

  const deploy = prisma(['migrate', 'deploy', '--schema', schemaPath], databaseUrl);
  if (deploy.status !== 0) {
    fail('the migration chain does not apply to an empty database', deploy.output);
  }

  const diff = prisma(
    [
      'migrate',
      'diff',
      '--from-url',
      databaseUrl,
      '--to-schema-datamodel',
      schemaPath,
      '--script',
    ],
    databaseUrl,
  );
  if (diff.status !== 0) {
    fail('prisma migrate diff could not compare the migrations with the datamodel', diff.output);
  }
  if (!diff.output.includes('This is an empty migration')) {
    fail(
      'schema.prisma and the migration chain disagree; write a migration for the datamodel change',
      diff.output,
    );
  }

  process.stdout.write(
    [
      'verify-migration-consistency: OK',
      `  migrations applied from empty: ${migrations.length}`,
      '  datamodel drift: none (empty migration)',
      '',
    ].join('\n'),
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
