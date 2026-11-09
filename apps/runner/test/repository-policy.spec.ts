import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  repositoryPolicyVersion,
  validateRepositoryPath,
  type RepositoryPolicyConfig,
} from '../src/repository-policy';

let root: string;
let allowed: string;
let worktrees: string;
let recovery: string;
let repo: string;
let outsideRepo: string;
let bare: string;
let linked: string;
let submoduleParent: string;
let submodule: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Haft Tests',
      GIT_AUTHOR_EMAIL: 'tests@haft.local',
      GIT_COMMITTER_NAME: 'Haft Tests',
      GIT_COMMITTER_EMAIL: 'tests@haft.local',
    },
  }).trim();
}

function createRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init']);
  writeFileSync(join(path, 'README.md'), '# test repository\n');
  git(path, ['add', 'README.md']);
  git(path, ['commit', '-m', 'initial']);
  return path;
}

function policy(overrides: Partial<RepositoryPolicyConfig> = {}): RepositoryPolicyConfig {
  return {
    allowedRepositoryRoots: [allowed],
    worktreeRoot: worktrees,
    recoveryRoot: recovery,
    gitBinary: 'git',
    ...overrides,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'haft-repository-policy-'));
  allowed = join(root, 'allowed');
  worktrees = join(root, 'worktrees');
  recovery = join(root, 'recovery');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  mkdirSync(recovery, { recursive: true });
  repo = createRepo(join(allowed, 'repo'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  outsideRepo = createRepo(join(root, 'outside-repo'));
  createRepo(join(root, 'allowed-evil'));
  bare = join(root, 'bare.git');
  git(root, ['init', '--bare', bare]);
  linked = join(allowed, 'linked-worktree');
  git(repo, ['worktree', 'add', '-b', 'linked-branch', linked]);
  submoduleParent = createRepo(join(allowed, 'parent'));
  git(submoduleParent, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    outsideRepo,
    'submodule',
  ]);
  git(submoduleParent, ['commit', '-m', 'add submodule']);
  submodule = join(submoduleParent, 'submodule');
});

afterAll(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('repository path policy', () => {
  it('fails closed when no allowed roots are configured', async () => {
    const result = await validateRepositoryPath(repo, policy({ allowedRepositoryRoots: [] }));
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REPOSITORY_POLICY_NOT_CONFIGURED',
    });
  });

  it('rejects relative paths, traversal, UNC, and device paths', async () => {
    const relative = await validateRepositoryPath('repos/repo', policy());
    expect(relative).toMatchObject({ ok: false, errorCode: 'REPO_PATH_NOT_ABSOLUTE' });

    const traversal = await validateRepositoryPath(
      `${allowed}${sep}..${sep}outside-repo`,
      policy(),
    );
    expect(traversal).toMatchObject({ ok: false, errorCode: 'REPO_PATH_TRAVERSAL' });

    const unc = await validateRepositoryPath('\\\\server\\share\\repo', policy());
    expect(unc).toMatchObject({ ok: false, errorCode: 'REPO_UNC_NOT_ALLOWED' });

    const device = await validateRepositoryPath('\\\\?\\C:\\repos\\repo', policy());
    expect(device).toMatchObject({ ok: false, errorCode: 'REPO_PATH_INVALID' });
  });

  it('uses path.relative rather than string prefixes for allowed roots', async () => {
    const result = await validateRepositoryPath(join(root, 'allowed-evil'), policy());
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REPO_PATH_OUTSIDE_ALLOWED_ROOTS',
    });
  });

  it('rejects missing paths, plain directories, and bare repositories', async () => {
    const missing = await validateRepositoryPath(join(allowed, 'missing'), policy());
    expect(missing).toMatchObject({ ok: false, errorCode: 'REPO_PATH_NOT_FOUND' });

    const plain = join(allowed, 'plain-directory');
    mkdirSync(plain, { recursive: true });
    const notGit = await validateRepositoryPath(plain, policy());
    expect(notGit).toMatchObject({ ok: false, errorCode: 'REPO_NOT_GIT_ROOT' });

    const bareResult = await validateRepositoryPath(bare, policy());
    expect(bareResult).toMatchObject({
      ok: false,
      errorCode: 'REPO_PATH_OUTSIDE_ALLOWED_ROOTS',
    });
    const bareInsideAllowed = await validateRepositoryPath(
      bare,
      policy({ allowedRepositoryRoots: [root] }),
    );
    expect(bareInsideAllowed).toMatchObject({
      ok: false,
      errorCode: 'REPO_BARE_UNSUPPORTED',
    });
  });

  it('rejects a subdirectory instead of treating it as the worktree root', async () => {
    const result = await validateRepositoryPath(join(repo, 'src'), policy());
    expect(result).toMatchObject({ ok: false, errorCode: 'REPO_NOT_GIT_ROOT' });
  });

  it('rejects linked worktrees and submodules', async () => {
    const linkedResult = await validateRepositoryPath(linked, policy());
    expect(linkedResult).toMatchObject({ ok: false, errorCode: 'REPO_PATH_IS_WORKTREE' });

    const submoduleResult = await validateRepositoryPath(submodule, policy());
    expect(submoduleResult).toMatchObject({ ok: false, errorCode: 'REPO_PATH_IS_WORKTREE' });
  });

  it('rejects repositories inside the worktree or recovery root', async () => {
    const worktreeRepo = createRepo(join(worktrees, 'quarantined'));
    expect(
      await validateRepositoryPath(
        worktreeRepo,
        policy({ allowedRepositoryRoots: [allowed, worktrees] }),
      ),
    ).toMatchObject({
      ok: false,
      errorCode: 'REPO_PATH_NESTED_IN_WORKTREE_ROOT',
    });
    const recoveryRepo = createRepo(join(recovery, 'quarantined'));
    expect(
      await validateRepositoryPath(
        recoveryRepo,
        policy({ allowedRepositoryRoots: [allowed, recovery] }),
      ),
    ).toMatchObject({
      ok: false,
      errorCode: 'REPO_PATH_NESTED_IN_WORKTREE_ROOT',
    });
  });

  it('rejects symlinks and junctions that escape an allowed root', async () => {
    const link = join(allowed, 'escape-link');
    symlinkSync(outsideRepo, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await validateRepositoryPath(link, policy());
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REPO_PATH_OUTSIDE_ALLOWED_ROOTS',
    });
  });

  it('returns canonical path, HEAD commit, platform, and a stable policy version', async () => {
    const result = await validateRepositoryPath(repo, policy());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonicalPath).toBe(realpathSync(repo));
    expect(result.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.platform).toBe(process.platform);
    expect(result.policyVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(repositoryPolicyVersion(policy())).toBe(result.policyVersion);
    expect(
      repositoryPolicyVersion(policy({ allowedRepositoryRoots: [allowed, recovery] })),
    ).not.toBe(result.policyVersion);
  });
});
