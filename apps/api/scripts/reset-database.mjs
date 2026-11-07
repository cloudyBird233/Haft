import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Removes a disposable test SQLite database and its WAL sidecars before
 * `prisma db push --force-reset` runs.
 *
 * SQLite can leave `-wal`/`-shm` files behind when a previous test run is
 * interrupted. Reusing a half-written database then fails with "database disk
 * image is malformed", which Prisma cannot always recover from even with
 * `--force-reset`. Deleting the files first makes test startup deterministic.
 *
 * Safety: only `test.db`, `e2e.db` and `real-e2e.db` are allowed. The
 * development database is never touched by this script.
 */
const url = process.env.DATABASE_URL;
if (!url || !url.startsWith('file:')) {
  console.error('reset-database: DATABASE_URL must be a file: URL');
  process.exit(1);
}

const fileName = url.slice('file:'.length).split('?')[0] ?? '';
const baseName = fileName.split('/').pop();
const DISPOSABLE = new Set(['test.db', 'e2e.db', 'real-e2e.db']);
if (!baseName || !DISPOSABLE.has(baseName)) {
  console.error(
    `reset-database: refusing to delete "${fileName}" (only ${[...DISPOSABLE].join(', ')} are disposable)`,
  );
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(scriptDir, '..', 'prisma');
const dbPath = resolve(schemaDir, fileName);

const removed = [];
for (const suffix of ['', '-wal', '-shm']) {
  const target = `${dbPath}${suffix}`;
  if (existsSync(target)) {
    rmSync(target, { force: true });
    removed.push(target);
  }
}

console.log(
  removed.length > 0
    ? `reset-database: removed ${removed.map((file) => file.split(/[\\/]/).pop()).join(', ')}`
    : `reset-database: no existing files for ${baseName}`,
);
