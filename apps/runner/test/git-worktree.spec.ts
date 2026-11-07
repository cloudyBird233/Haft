import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
