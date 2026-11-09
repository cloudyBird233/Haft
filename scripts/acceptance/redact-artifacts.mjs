#!/usr/bin/env node
/**
 * Removes known credential-bearing files and redacts common secret patterns
 * before an artifact directory is uploaded. It never prints a secret value.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = resolve(process.argv[2] ?? join(repoRoot, 'ci-artifacts'));

const textExtensions = new Set([
  '.json',
  '.xml',
  '.txt',
  '.log',
  '.md',
  '.html',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
  '.patch',
  '.diff',
  '.csv',
  '.out',
]);

const sensitiveNames = [/^\.env(?:\.|$)/i, /^auth\.json$/i, /^.*\.db(?:-journal|-wal|-shm)?$/i];

const patterns = [
  { name: 'github-token', regex: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'openai-style-key', regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  { name: 'bearer', regex: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  {
    name: 'runner-bootstrap-token',
    regex: /\bHAFT_RUNNER_BOOTSTRAP_TOKEN\s*[:=]\s*["']?[^"'\s]+/gi,
  },
  { name: 'codex-auth-env', regex: /\bHAFT_CODEX_AUTH_JSON\s*[:=]\s*["']?[^"'\s]+/gi },
  {
    name: 'json-token-field',
    regex: /("(?:access_token|refresh_token|id_token|api_key|apikey)"\s*:\s*")[^"]+(")/gi,
  },
];

const secretEnvNames = [
  'HAFT_CODEX_AUTH_JSON',
  'HAFT_RUNNER_BOOTSTRAP_TOKEN',
  'E2E_RUNNER_BOOTSTRAP_TOKEN',
  'REAL_E2E_RUNNER_BOOTSTRAP_TOKEN',
  'GITHUB_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
];
const secretValues = secretEnvNames
  .map((name) => process.env[name])
  .filter((value) => typeof value === 'string' && value.length >= 8);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: relative(repoRoot, target).replaceAll('\\', '/') || '.',
  scannedFiles: 0,
  redactedFiles: [],
  removedFiles: [],
  matches: {},
};

function isSensitiveFile(path) {
  const name = path.split(/[\\/]/).pop() ?? '';
  const normalized = path.replaceAll('\\', '/');
  if (normalized.includes('/.runner/')) return true;
  return sensitiveNames.some((pattern) => pattern.test(name));
}

function redactText(text) {
  let result = text;
  const matches = {};
  for (const secret of secretValues) {
    if (result.includes(secret)) {
      result = result.split(secret).join('[REDACTED]');
      matches['env-secret'] = (matches['env-secret'] ?? 0) + 1;
    }
  }
  for (const pattern of patterns) {
    result = result.replace(pattern.regex, (...args) => {
      matches[pattern.name] = (matches[pattern.name] ?? 0) + 1;
      if (pattern.name === 'bearer') return 'Bearer [REDACTED]';
      if (pattern.name === 'json-token-field') return `${args[1]}[REDACTED]${args[2]}`;
      return '[REDACTED]';
    });
  }
  return { result, matches };
}

function walk(path) {
  if (!existsSync(path)) return;
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  if (isSensitiveFile(path)) {
    rmSync(path, { force: true });
    report.removedFiles.push(relative(target, path).replaceAll('\\', '/'));
    return;
  }
  report.scannedFiles += 1;
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (!textExtensions.has(extension)) return;
  const original = readFileSync(path, 'utf8');
  const { result, matches } = redactText(original);
  if (result !== original) {
    writeFileSync(path, result, 'utf8');
    report.redactedFiles.push(relative(target, path).replaceAll('\\', '/'));
    for (const [name, count] of Object.entries(matches)) {
      report.matches[name] = (report.matches[name] ?? 0) + count;
    }
  }
}

mkdirSync(target, { recursive: true });
walk(target);
writeFileSync(
  join(target, 'redaction-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
console.log(
  `redact: scanned=${report.scannedFiles} redacted=${report.redactedFiles.length} removed=${report.removedFiles.length}`,
);
