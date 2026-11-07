import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXECUTION_DIFF_MAX_BYTES } from '@raft-lite/contracts';
import { GitWorktreeError, GitWorktreeManager } from '../src/git-worktree';
import { runProcess } from '../src/process-utils';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-worktree-'));
  roots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess('git', ['-C', cwd, ...args], {
    timeoutMs: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

async function initRepo(root: string): Promise<string> {
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init']);
  await writeFile(join(repo, 'README.md'), '# Fixture\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, [
    '-c',
    'user.name=Haft Test',
    '-c',
    'user.email=haft-test@example.com',
    'commit',
    '-m',
    'initial',
  ]);
  return repo;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('GitWorktreeManager', () => {
  it('creates an isolated worktree, reports untracked and committed changes, then cleans up', async () => {
    const root = await makeRoot();
    const repo = await initRepo(root);
    const manager = new GitWorktreeManager({
      gitBinary: 'git',
      worktreeRoot: join(root, 'worktrees'),
      keepWorktrees: false,
    });

    const info = await manager.prepare(repo, 'project_demo', 'execution_worktree');
    expect(info.branchName).toBe('haft/execution_worktree');
    expect((await stat(info.path)).isDirectory()).toBe(true);
    expect(info.path.startsWith(join(root, 'worktrees'))).toBe(true);

    await writeFile(join(info.path, 'feature.txt'), 'new file\n', 'utf8');
    const untracked = await manager.collect(info);
    expect(untracked).toMatchObject({
      branchName: 'haft/execution_worktree',
      changedFiles: 1,
    });
    expect(untracked?.gitStatus).toContain('?? feature.txt');
    expect(untracked?.diffStat).toContain('feature.txt');

    await git(info.path, ['add', 'feature.txt']);
    await git(info.path, [
      '-c',
      'user.name=Haft Test',
      '-c',
      'user.email=haft-test@example.com',
      'commit',
      '-m',
      'feature',
    ]);
    const committed = await manager.collect(info);
    expect(committed?.changedFiles).toBe(1);
    expect(committed?.headCommit).not.toBe(info.baseCommit);
    expect(committed?.diffStat).toContain('feature.txt');

    const cleanup = await manager.cleanup(info, repo);
    expect(cleanup.removed).toBe(true);
    await expect(stat(info.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await git(repo, ['show-ref', '--verify', 'refs/heads/haft/execution_worktree']);
  });

  it('collects modified, added, deleted and renamed files in one unified diff', async () => {
    const root = await makeRoot();
    const repo = await initRepo(root);
    await writeFile(join(repo, 'tracked.txt'), 'line one\nline two\n', 'utf8');
    await writeFile(join(repo, 'rename-me.txt'), 'rename fixture\n', 'utf8');
    await git(repo, ['add', 'tracked.txt', 'rename-me.txt']);
    await git(repo, [
      '-c',
      'user.name=Haft Test',
      '-c',
      'user.email=haft-test@example.com',
      'commit',
      '-m',
      'diff fixtures',
    ]);

    const manager = new GitWorktreeManager({
      gitBinary: 'git',
      worktreeRoot: join(root, 'worktrees'),
      keepWorktrees: true,
    });
    const info = await manager.prepare(repo, 'project_demo', 'execution_diff_states');
    const baseHead = (await runProcess('git', ['-C', info.path, 'rev-parse', 'HEAD'])).stdout.trim();

    await writeFile(join(info.path, 'tracked.txt'), 'line one\nline two changed\n', 'utf8');
    await writeFile(join(info.path, 'added.txt'), 'brand new\n', 'utf8');
    await rm(join(info.path, 'README.md'));
    await git(info.path, ['mv', 'rename-me.txt', 'renamed.txt']);

    const result = await manager.collect(info);
    expect(result).not.toBeNull();
    expect(result?.changedFiles).toBe(4);
    expect(result?.diffTruncated).toBe(false);

    const diff = result?.diff ?? '';
    expect(diff).toContain('diff --git a/tracked.txt b/tracked.txt');
    expect(diff).toContain('+line two changed');
    expect(diff).toContain('diff --git a/README.md b/README.md');
    expect(diff).toContain('deleted file mode');
    expect(diff).toContain('-# Fixture');
    expect(diff).toContain('rename from rename-me.txt');
    expect(diff).toContain('rename to renamed.txt');
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+++ b/added.txt');
    expect(diff).toContain('+brand new');

    // Collecting must never stage, commit or move HEAD; the original repository
    // and the worktree branch stay exactly where the runner created them.
    expect(result?.headCommit).toBe(baseHead);
    expect(result?.baseCommit).toBe(baseHead);
    expect(result?.gitStatus).toContain('?? added.txt');
    expect(result?.gitStatus).toContain(' D README.md');
    const statusAfter = await runProcess('git', ['-C', info.path, 'status', '--porcelain=v1']);
    expect(statusAfter.stdout).toContain('?? added.txt');
    const logAfter = await runProcess('git', ['-C', info.path, 'rev-list', '--count', 'HEAD']);
    expect(logAfter.stdout.trim()).toBe('2');
  });

  it('reports binary changes without rendering a textual patch', async () => {
    const root = await makeRoot();
    const repo = await initRepo(root);
    await writeFile(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
    await git(repo, ['add', 'image.bin']);
    await git(repo, [
      '-c',
      'user.name=Haft Test',
      '-c',
      'user.email=haft-test@example.com',
      'commit',
      '-m',
      'binary fixture',
    ]);
    const manager = new GitWorktreeManager({
      gitBinary: 'git',
      worktreeRoot: join(root, 'worktrees'),
      keepWorktrees: true,
    });
    const info = await manager.prepare(repo, 'project_demo', 'execution_binary');
    await writeFile(join(info.path, 'image.bin'), Buffer.from([0, 1, 9, 9, 9, 5]));

    const result = await manager.collect(info);
    expect(result?.changedFiles).toBe(1);
    expect(result?.diff).toContain('Binary files a/image.bin and b/image.bin differ');
    expect(result?.diffStat).toContain('Bin');
  });

  it('truncates patches larger than the configured size limit and flags it', async () => {
    const root = await makeRoot();
    const repo = await initRepo(root);
    const manager = new GitWorktreeManager({
      gitBinary: 'git',
      worktreeRoot: join(root, 'worktrees'),
      keepWorktrees: true,
    });
    const info = await manager.prepare(repo, 'project_demo', 'execution_truncated');
    const bigLine = `${'x'.repeat(1000)}\n`;
    await writeFile(
      join(info.path, 'huge.txt'),
      `header\n${bigLine.repeat(Math.ceil((EXECUTION_DIFF_MAX_BYTES + 64 * 1024) / 1001))}`,
      'utf8',
    );

    const result = await manager.collect(info);
    expect(result?.diffTruncated).toBe(true);
    expect(Buffer.byteLength(result?.diff ?? '', 'utf8')).toBeLessThanOrEqual(
      EXECUTION_DIFF_MAX_BYTES,
    );
    expect(result?.diff.length).toBeGreaterThan(0);
  });

  it('returns an empty diff when the worktree has no changes', async () => {
    const root = await makeRoot();
    const repo = await initRepo(root);
    const manager = new GitWorktreeManager({
      gitBinary: 'git',
      worktreeRoot: join(root, 'worktrees'),
      keepWorktrees: true,
    });
    const info = await manager.prepare(repo, 'project_demo', 'execution_empty');

    const result = await manager.collect(info);
    expect(result).toMatchObject({
      changedFiles: 0,
      diff: '',
      diffTruncated: false,
      branchName: 'haft/execution_empty',
    });
    expect(result?.headCommit).toBe(info.baseCommit);
  });

  it('keeps the worktree when configured to preserve execution artifacts', async () => {
    const root = await makeRoot();
    const repo = await initRepo(root);
    const manager = new GitWorktreeManager({
      gitBinary: 'git',
      worktreeRoot: join(root, 'worktrees'),
      keepWorktrees: true,
    });
    const info = await manager.prepare(repo, 'project_demo', 'execution_keep');
    const cleanup = await manager.cleanup(info, repo);
    expect(cleanup).toMatchObject({ removed: false, path: info.path });
    expect((await stat(info.path)).isDirectory()).toBe(true);
  });

  it('refuses a project path that is not the repository root', async () => {
    const root = await makeRoot();
    const repo = await initRepo(root);
    const subdirectory = join(repo, 'packages');
    await mkdir(subdirectory);
    const manager = new GitWorktreeManager({
      gitBinary: 'git',
      worktreeRoot: join(root, 'worktrees'),
      keepWorktrees: false,
    });
    await expect(manager.prepare(subdirectory, 'project_demo', 'execution_sub')).rejects.toMatchObject({
      code: 'PROJECT_NOT_GIT_ROOT',
    });
    await expect(
      manager.prepare(subdirectory, 'project_demo', 'execution_sub'),
    ).rejects.toBeInstanceOf(GitWorktreeError);
  });
});
