#!/usr/bin/env node
/**
 * Materializes the protected environment secret into an isolated CODEX_HOME.
 * The secret is never printed, logged, copied to the repository, or exposed to
 * the test process environment.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const root = process.env.HAFT_REAL_CLI_ROOT;
const codexHome = process.env.CODEX_HOME;
const auth = process.env.HAFT_CODEX_AUTH_JSON;

if (!root || !codexHome) {
  console.error('materialize-codex-auth: HAFT_REAL_CLI_ROOT and CODEX_HOME are required');
  process.exit(1);
}
if (!auth || auth.trim().length === 0) {
  console.error('materialize-codex-auth: HAFT_CODEX_AUTH_JSON environment secret is missing');
  process.exit(1);
}

const isolatedRoot = resolve(root);
const isolatedCodexHome = resolve(codexHome);
if (isInside(repoRoot, isolatedRoot) || isInside(repoRoot, isolatedCodexHome)) {
  console.error(
    'materialize-codex-auth: isolation root and CODEX_HOME must be outside the checkout',
  );
  process.exit(1);
}
const rel = relative(isolatedRoot, isolatedCodexHome);
if (rel.startsWith('..') || isAbsolute(rel)) {
  console.error('materialize-codex-auth: CODEX_HOME must be inside HAFT_REAL_CLI_ROOT');
  process.exit(1);
}

try {
  const parsed = JSON.parse(auth);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('auth payload is not a JSON object');
  }
} catch (error) {
  console.error(`materialize-codex-auth: invalid auth payload (${error.message})`);
  process.exit(1);
}

const target = join(isolatedCodexHome, 'auth.json');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
writeFileSync(target, auth, { encoding: 'utf8', mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  // Windows does not implement POSIX modes; the file remains in the isolated root.
}

console.log(`materialize-codex-auth: wrote isolated auth file under ${isolatedCodexHome}`);
