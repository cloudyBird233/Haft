#!/usr/bin/env node
/**
 * Collects redaction-ready real CLI evidence before cleanup:
 * Playwright artifacts, runner recovery logs, workspace Git state and per-worktree diffs.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(
  process.env.CI_REAL_CLI_ARTIFACT_DIR ?? join(repoRoot, 'ci-artifacts', 'real-cli'),
);
const evidenceDir = join(artifactDir, 'evidence');
const realRoot = join(repoRoot, 'test-results', 'real-e2e');
const workspace = join(realRoot, 'workspace');
const worktrees = join(realRoot, 'worktrees');
mkdirSync(evidenceDir, { recursive: true });

const collection = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceRoot: relative(repoRoot, realRoot).replaceAll('\\', '/'),
  copied: [],
  git: [],
  diffs: [],
  notes: [],
};

function git(args, cwd) {
  return execFileSync('git', ['-C', cwd, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Haft E2E',
      GIT_AUTHOR_EMAIL: 'haft-e2e@example.com',
      GIT_COMMITTER_NAME: 'Haft E2E',
      GIT_COMMITTER_EMAIL: 'haft-e2e@example.com',
    },
  });
}

function writeEvidence(relativePath, content) {
  const target = join(evidenceDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  collection.git.push(relativePath);
}

function copyDirectory(source, target, filter) {
  if (!existsSync(source)) {
    collection.notes.push(`missing: ${relative(repoRoot, source).replaceAll('\\', '/')}`);
    return;
  }
  cpSync(source, target, { recursive: true, force: true, filter });
  collection.copied.push(relative(artifactDir, target).replaceAll('\\', '/'));
}

copyDirectory(
  join(realRoot, 'playwright'),
  join(evidenceDir, 'playwright'),
  (source) => !source.includes('.runner'),
);
copyDirectory(
  join(realRoot, 'recovery'),
  join(evidenceDir, 'recovery'),
  (source) => !source.includes('.runner'),
);

if (existsSync(workspace)) {
  try {
    writeEvidence('git/workspace-head.txt', git(['rev-parse', 'HEAD'], workspace));
    writeEvidence('git/workspace-status.txt', git(['status', '--porcelain'], workspace));
    writeEvidence('git/workspace-remotes.txt', git(['remote', '-v'], workspace));
    writeEvidence('git/worktrees.txt', git(['worktree', 'list', '--porcelain'], workspace));
    writeEvidence('git/workspace-diff-stat.txt', git(['diff', '--stat'], workspace));
  } catch (error) {
    collection.notes.push(`workspace git inspection failed: ${error.message}`);
  }
} else {
  collection.notes.push('test-results/real-e2e/workspace was not created');
}

function collectWorktreeDiff(path, executionId) {
  try {
    const status = git(['status', '--porcelain'], path);
    const diff = git(['diff'], path);
    const stat = git(['diff', '--stat'], path);
    const untracked = git(['ls-files', '--others', '--exclude-standard'], path)
      .split(/\r?\n/)
      .filter(Boolean);
    const directory = join(evidenceDir, 'diffs', executionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'status.txt'), status, 'utf8');
    writeFileSync(join(directory, 'diff.patch'), diff, 'utf8');
    writeFileSync(join(directory, 'diff-stat.txt'), stat, 'utf8');
    writeFileSync(join(directory, 'untracked.txt'), `${untracked.join('\n')}\n`, 'utf8');
    collection.diffs.push({
      executionId,
      worktree: relative(repoRoot, path).replaceAll('\\', '/'),
      statusBytes: Buffer.byteLength(status),
      diffBytes: Buffer.byteLength(diff),
      untrackedFiles: untracked,
    });
  } catch (error) {
    collection.notes.push(`worktree ${executionId} diff failed: ${error.message}`);
  }
}

if (existsSync(worktrees)) {
  for (const project of readdirSync(worktrees, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(worktrees, project.name);
    for (const execution of readdirSync(projectDir, { withFileTypes: true })) {
      if (!execution.isDirectory()) continue;
      collectWorktreeDiff(join(projectDir, execution.name), execution.name);
    }
  }
}

const evidenceFiles = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) evidenceFiles.push(relative(evidenceDir, full).replaceAll('\\', '/'));
  }
}
walk(evidenceDir);
collection.evidenceFiles = evidenceFiles.sort();

writeFileSync(
  join(evidenceDir, 'collection.json'),
  `${JSON.stringify(collection, null, 2)}\n`,
  'utf8',
);
console.log(
  `real-cli evidence collected: copied=${collection.copied.length} diffs=${collection.diffs.length} files=${evidenceFiles.length}`,
);
