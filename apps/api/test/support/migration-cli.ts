import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Test helpers that drive the real Prisma CLI.
 *
 * Every database used by the migration suite is created by `prisma migrate
 * deploy`; `prisma db push` is never used, because a pushed schema would prove
 * nothing about the migrations that production actually runs.
 */

export const API_ROOT = resolve(__dirname, '../..');
export const PRISMA_SCHEMA = join(API_ROOT, 'prisma', 'schema.prisma');
export const MIGRATIONS_DIR = join(API_ROOT, 'prisma', 'migrations');
const PRISMA_ENTRY = join(API_ROOT, 'node_modules', 'prisma', 'build', 'index.js');

export interface PrismaRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runPrisma(
  args: string[],
  env: Record<string, string | undefined> = {},
): PrismaRunResult {
  const result = spawnSync(process.execPath, [PRISMA_ENTRY, ...args], {
    cwd: API_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runPrismaOrThrow(
  args: string[],
  env: Record<string, string | undefined> = {},
): PrismaRunResult {
  const result = runPrisma(args, env);
  if (result.status !== 0) {
    throw new Error(
      `prisma ${args.join(' ')} failed with status ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

/** `file:` URL with forward slashes, which SQLite accepts on every platform. */
export function sqliteUrl(absolutePath: string): string {
  return `file:${absolutePath.replace(/\\/g, '/')}`;
}

export const SLICE1_MIGRATION = '20261116120000_p2_02_wpd_slice1_schema_migration';

/** Migration directories that existed before WP-D Slice 1, in apply order. */
export function legacyMigrationIds(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== SLICE1_MIGRATION)
    .map((entry) => entry.name)
    .sort();
}

export interface TempDatabase {
  dir: string;
  path: string;
  url: string;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDatabases(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Creates an empty SQLite file and applies the real migration chain, either the
 * full chain or only the pre-Slice-1 migrations.
 */
export function createMigratedDatabase(options: {
  label: string;
  legacyOnly?: boolean;
}): TempDatabase {
  const dir = makeTempDir(`haft-${options.label}-`);
  const path = join(dir, 'database.db');

  if (options.legacyOnly) {
    const legacySchemaDir = join(dir, 'legacy');
    mkdirSync(join(legacySchemaDir, 'migrations'), { recursive: true });
    writeFileSync(join(legacySchemaDir, 'schema.prisma'), readFileSync(PRISMA_SCHEMA, 'utf8'));
    for (const id of legacyMigrationIds()) {
      cpSync(join(MIGRATIONS_DIR, id), join(legacySchemaDir, 'migrations', id), {
        recursive: true,
      });
    }
    cpSync(
      join(MIGRATIONS_DIR, 'migration_lock.toml'),
      join(legacySchemaDir, 'migrations', 'migration_lock.toml'),
    );
    runPrismaOrThrow(['migrate', 'deploy', '--schema', join(legacySchemaDir, 'schema.prisma')], {
      DATABASE_URL: sqliteUrl(path),
    });
    return { dir, path, url: sqliteUrl(path) };
  }

  runPrismaOrThrow(['migrate', 'deploy', '--schema', PRISMA_SCHEMA], {
    DATABASE_URL: sqliteUrl(path),
  });
  return { dir, path, url: sqliteUrl(path) };
}

/** Copies an existing database file so the upgrade happens on a private copy. */
export function copyDatabase(source: TempDatabase, label: string): TempDatabase {
  const dir = makeTempDir(`haft-${label}-`);
  const path = join(dir, 'database.db');
  cpSync(source.path, path);
  return { dir, path, url: sqliteUrl(path) };
}

/** Applies the migrations that are still pending on an existing database. */
export function applyPendingMigrations(database: TempDatabase): PrismaRunResult {
  return runPrisma(['migrate', 'deploy', '--schema', PRISMA_SCHEMA], {
    DATABASE_URL: database.url,
  });
}
