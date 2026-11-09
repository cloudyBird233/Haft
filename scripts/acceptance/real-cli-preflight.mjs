#!/usr/bin/env node
/**
 * Preflight for the protected real Codex CLI workflow.
 *
 * It fails closed: missing credentials, an unauthenticated CLI, an unexpected
 * version, a non-isolated HOME/CODEX_HOME, a dirty checkout, a busy port or a
 * leftover test workspace all produce BLOCKED instead of a skipped test.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(
  process.env.CI_REAL_CLI_ARTIFACT_DIR ?? join(repoRoot, 'ci-artifacts', 'real-cli'),
);
mkdirSync(artifactDir, { recursive: true });

const checks = [];
const sensitiveNames = [
  'HAFT_CODEX_AUTH_JSON',
  'HAFT_RUNNER_BOOTSTRAP_TOKEN',
  'REAL_E2E_RUNNER_BOOTSTRAP_TOKEN',
];

function sanitizedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('HAFT_') || key.startsWith('E2E_RUNNER_')) continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  return env;
}

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function fail(name, message) {
  record(name, false, message);
  throw new Error(`${name}: ${message}`);
}

function writeResult(status, error) {
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    commit: process.env.HAFT_REAL_CLI_COMMIT ?? null,
    runner: {
      environment: process.env.RUNNER_ENVIRONMENT ?? null,
      name: process.env.RUNNER_NAME ?? null,
      os: process.platform,
    },
    codex: {
      version: process.env.HAFT_CODEX_VERSION ?? null,
      binarySha256: process.env.HAFT_CODEX_BIN_SHA256 ?? null,
      authenticated: checks.find((check) => check.name === 'codex-authentication')?.ok ?? false,
    },
    environment: {
      node: process.version,
      pnpm: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).packageManager,
      isolatedRoot: process.env.HAFT_REAL_CLI_ROOT ?? null,
      homeIsolated: checks.find((check) => check.name === 'isolated-home')?.ok ?? false,
      codexHomeIsolated: checks.find((check) => check.name === 'isolated-codex-home')?.ok ?? false,
    },
    checks,
    error: error ?? null,
  };
  writeFileSync(
    join(artifactDir, 'preflight.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  return result;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: sanitizedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail('environment', `${name} is required`);
  return value;
}

function checkPort(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (free) => {
      socket.destroy();
      resolvePort(free);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

function findExecutable(bin) {
  if (isAbsolute(bin)) return bin;
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const output = run(locator, [bin]).split(/\r?\n/)[0]?.trim();
  if (!output) fail('codex-binary', `${bin} was not found on PATH`);
  return output;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
  const root = resolve(requireEnv('HAFT_REAL_CLI_ROOT'));
  if (isInside(repoRoot, root)) {
    fail('isolated-root', 'HAFT_REAL_CLI_ROOT must be outside the Git checkout');
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const directory of ['home', 'codex-home', 'tmp', 'worktrees', 'recovery']) {
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  }
  record('isolated-root', true, root);

  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT !== 'self-hosted') {
    fail(
      'dedicated-runner',
      'real-cli must run on a self-hosted dedicated runner, not a GitHub-hosted runner',
    );
  }
  if (process.env.GITHUB_ACTIONS !== 'true' && process.env.HAFT_REAL_CLI_ALLOW_LOCAL !== '1') {
    fail(
      'dedicated-runner',
      'set HAFT_REAL_CLI_ALLOW_LOCAL=1 only for a local preflight smoke test',
    );
  }
  record('dedicated-runner', true, process.env.RUNNER_ENVIRONMENT ?? 'local-approved');

  if (process.getuid?.() === 0) fail('non-root-user', 'the real CLI must not run as root');
  if (
    process.platform === 'win32' &&
    String(process.env.USERNAME ?? '').toLowerCase() === 'administrator'
  ) {
    fail('non-root-user', 'the real CLI must not run as Administrator');
  }
  const allowedUser = process.env.HAFT_REAL_CLI_ALLOWED_USER?.trim();
  const currentUser = process.env.USER ?? process.env.USERNAME ?? 'unknown';
  if (allowedUser && currentUser !== allowedUser) {
    fail(
      'non-root-user',
      `the isolated runner must use the dedicated account ${allowedUser}, not ${currentUser}`,
    );
  }
  record('non-root-user', true, currentUser);

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home || !isInside(root, resolve(home))) {
    fail('isolated-home', 'HOME/USERPROFILE must be inside HAFT_REAL_CLI_ROOT');
  }
  record('isolated-home', true, home);

  const codexHome = process.env.CODEX_HOME;
  if (
    !codexHome ||
    !isInside(root, resolve(codexHome)) ||
    isInside(resolve(home), resolve(codexHome))
  ) {
    fail(
      'isolated-codex-home',
      'CODEX_HOME must be an isolated directory under HAFT_REAL_CLI_ROOT, outside HOME',
    );
  }
  const hostHome = process.env.HAFT_REAL_CLI_HOST_HOME;
  if (hostHome && isInside(resolve(hostHome), resolve(codexHome))) {
    fail('isolated-codex-home', 'CODEX_HOME must not be inside the host personal home directory');
  }
  const personalCodexHome = join(homedir(), '.codex');
  if (resolve(codexHome) === resolve(personalCodexHome)) {
    fail('isolated-codex-home', 'CODEX_HOME must not be the personal ~/.codex directory');
  }
  record('isolated-codex-home', true, codexHome);

  if (process.env.HAFT_REAL_CLI_E2E !== '1')
    fail('real-cli-gate', 'HAFT_REAL_CLI_E2E=1 is required');
  if (process.env.HAFT_REAL_CLI_REQUIRED !== '1')
    fail('real-cli-gate', 'HAFT_REAL_CLI_REQUIRED=1 is required');
  record('real-cli-gate', true, 'HAFT_REAL_CLI_E2E=1 and HAFT_REAL_CLI_REQUIRED=1');

  const expectedCommit = requireEnv('HAFT_REAL_CLI_COMMIT');
  const head = run('git', ['rev-parse', 'HEAD']);
  if (head !== expectedCommit)
    fail('fixed-commit', `HEAD ${head} does not match expected ${expectedCommit}`);
  try {
    run('git', ['merge-base', '--is-ancestor', head, 'origin/main']);
  } catch {
    fail('fixed-commit', 'HEAD is not reachable from origin/main');
  }
  record('fixed-commit', true, head);

  const status = run('git', ['status', '--porcelain']);
  if (status) fail('clean-worktree', `git status is not clean:\n${status}`);
  record('clean-worktree', true, 'git status --porcelain is empty');

  const expectedVersion = requireEnv('HAFT_CODEX_VERSION');
  const codexBin = findExecutable(process.env.HAFT_CODEX_BIN ?? 'codex');
  const versionOutput = run(codexBin, ['--version']);
  const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  if (!versionMatch) fail('codex-version', 'codex --version did not report a semantic version');
  if (versionMatch[1] !== expectedVersion) {
    fail(
      'codex-version',
      `codex version ${versionMatch[1]} does not match pinned ${expectedVersion}`,
    );
  }
  record('codex-version', true, versionMatch[1]);

  const binaryHash = sha256(codexBin);
  const expectedHash = process.env.HAFT_CODEX_BIN_SHA256?.trim().toLowerCase();
  if (process.env.HAFT_REAL_CLI_REQUIRE_CODEX_SHA256 === '1' && !expectedHash) {
    fail('codex-binary-sha256', 'HAFT_CODEX_BIN_SHA256 is required for this run');
  }
  if (expectedHash && binaryHash !== expectedHash) {
    fail(
      'codex-binary-sha256',
      `codex binary SHA256 ${binaryHash} does not match pinned ${expectedHash}`,
    );
  }
  process.env.HAFT_CODEX_BIN_SHA256 = binaryHash;
  record('codex-binary-sha256', true, binaryHash);

  const authFile = join(resolve(codexHome), 'auth.json');
  if (!existsSync(authFile) || statSync(authFile).size === 0) {
    fail('codex-auth-file', 'isolated CODEX_HOME/auth.json is missing or empty');
  }
  if (process.platform !== 'win32' && (statSync(authFile).mode & 0o077) !== 0) {
    fail('codex-auth-file', 'isolated auth.json must not be readable by group/other');
  }
  try {
    const parsed = JSON.parse(readFileSync(authFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  } catch {
    fail('codex-auth-file', 'isolated auth.json is not a valid JSON object');
  }
  record('codex-auth-file', true, 'isolated, mode-restricted auth.json');

  try {
    run(codexBin, ['login', 'status']);
  } catch {
    fail(
      'codex-authentication',
      'codex login status failed; the isolated test identity is not authenticated',
    );
  }
  record('codex-authentication', true, 'authenticated with isolated credentials');

  if (process.env.HAFT_REAL_E2E_OPENCODE === '1') {
    const model = process.env.HAFT_REAL_OPENCODE_MODEL;
    if (!model)
      fail(
        'opencode-gate',
        'OpenCode was explicitly enabled but HAFT_REAL_OPENCODE_MODEL is missing',
      );
    try {
      findExecutable(process.env.HAFT_OPENCODE_BIN ?? 'opencode');
    } catch {
      fail('opencode-gate', 'OpenCode was explicitly enabled but the opencode binary is missing');
    }
    record('opencode-gate', true, 'explicitly enabled with a model');
  } else {
    record('opencode-gate', true, 'OpenCode test disabled; its SKIPPED result is not a PASS');
  }

  for (const port of [3201, 5274, 3299]) {
    const free = await checkPort(port);
    if (!free) fail('ports', `port ${port} is already in use`);
  }
  record('ports', true, '3201, 5274 and 3299 are free');

  const leftovers = [
    'test-results/real-e2e',
    'apps/api/prisma/real-e2e.db',
    'apps/api/prisma/real-e2e.db-journal',
    'apps/api/prisma/real-e2e.db-wal',
    'apps/api/prisma/real-e2e.db-shm',
  ].filter((path) => existsSync(join(repoRoot, path)));
  if (leftovers.length > 0)
    fail('clean-temp-state', `leftover test state: ${leftovers.join(', ')}`);
  record('clean-temp-state', true, 'no previous real-e2e database, worktree or token leftovers');

  const exposedEnv = sensitiveNames.filter((name) => Object.hasOwn(process.env, name));
  if (exposedEnv.length > 0) {
    fail(
      'secret-scope',
      `secrets must not be present in the test environment: ${exposedEnv.join(', ')}`,
    );
  }
  record('secret-scope', true, 'CLI secret is not present in the preflight/test environment');

  const result = writeResult('PASS');
  console.log(
    `real-cli preflight PASS: commit=${result.commit} codex=${result.codex.version} hash=${binaryHash} runner=${result.runner.name ?? 'unknown'}`,
  );
}

main().catch((error) => {
  const result = writeResult('BLOCKED', error.message);
  console.error(`real-cli preflight BLOCKED: ${result.error}`);
  process.exit(1);
});
