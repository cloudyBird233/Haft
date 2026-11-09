#!/usr/bin/env node
/**
 * Records build output metadata without adding build products to Git.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(
  process.env.CI_STATIC_ARTIFACT_DIR ?? join(repoRoot, 'ci-artifacts', 'static'),
);
mkdirSync(artifactDir, { recursive: true });

const outputs = ['packages/contracts/dist', 'apps/api/dist', 'apps/web/dist', 'apps/runner/dist'];

function directorySize(path) {
  if (!existsSync(path)) return null;
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  }
  return total;
}

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
} catch {
  // Keep the report usable outside a Git checkout.
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit,
  node: process.version,
  pnpm: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).packageManager,
  outputs: outputs.map((output) => ({
    path: relative(repoRoot, resolve(repoRoot, output)).replaceAll('\\', '/'),
    exists: existsSync(resolve(repoRoot, output)),
    bytes: directorySize(resolve(repoRoot, output)),
  })),
  note: 'Build outputs are gitignored and are not uploaded as build artifacts.',
};

writeFileSync(
  join(artifactDir, 'build-summary.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(report, null, 2));
