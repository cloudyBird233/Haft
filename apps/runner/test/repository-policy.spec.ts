import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep, win32 } from 'node:path';
import { ERROR_CODES } from '@raft-lite/contracts';
import {
  RepositoryPathPolicy,
  containsPath,
  hasTraversalSegment,
  isWindowsDevicePath,
  serializePolicyVersionInput,
  type RepositoryPolicyConfig,
} from '../src/repository-policy';

const roots: string[] = [];

async function makeRoot(prefix = 'haft-policy-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
    },
  });
}

async function initRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, ['init']);
  await writeFile(join(path, 'README.md'), '# Fixture\n', 'utf8');
  git(path, ['add', 'README.md']);
  git(path, [
    '-c',
    'user.name=Haft Test',
    '-c',
    'user.email=haft-test@example.com',
    'commit',
    '-m',
    'initial',
  ]);
  return realpath(path);
}

function policyFor(
  root: string,
  overrides: Partial<RepositoryPolicyConfig> = {},
): RepositoryPathPolicy {
  return new RepositoryPathPolicy({
    allowedRepositoryRoots: [root],
    allowUnc: false,
    worktreeRoot: join(root, 'worktrees'),
    recoveryRoot: join(root, 'recovery'),
    gitBinary: 'git',
    platform: process.platform,
    ...overrides,
  });
}

async function createDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    console.warn(
      `Skipping link-dependent assertion: cannot create a directory link on ${process.platform}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch(() => undefined);
  }
});

describe('RepositoryPathPolicy validation', () => {
  it('accepts a real Git root inside an allowed root, with an allowed root equal to the repo', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const policy = policyFor(root);
    const result = await policy.validate(repo);
    expect(result).toMatchObject({
      ok: true,
      platform: process.platform,
      canonicalPath: repo,
      policyVersion: policy.policyVersion,
    });
    expect(result.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const equalityPolicy = policyFor(root, {
      allowedRepositoryRoots: [repo],
    });
    await expect(equalityPolicy.validate(repo)).resolves.toMatchObject({
      ok: true,
      canonicalPath: repo,
    });
  });

  it('does not perform a default-branch check', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    git(repo, ['branch', '-m', 'fixture-branch']);
    const missing = await policyFor(root).validate(repo);
    expect(missing.ok).toBe(true);
    expect(missing.errorCode).toBeUndefined();
    expect(RepositoryPathPolicy.prototype.validate).toHaveLength(1);
  });

  it('rejects relative paths, drive-relative paths, traversal and NUL bytes', async () => {
    const root = await makeRoot();
    await initRepo(join(root, 'repo'));
    const policy = policyFor(root);

    await expectRejected(policy, 'repo', ERROR_CODES.REPO_PATH_NOT_ABSOLUTE);
    await expectRejected(policy, 'C:repo', ERROR_CODES.REPO_PATH_NOT_ABSOLUTE);
    await expectRejected(
      policy,
      `${join(root, 'repo')}${sep}..${sep}repo`,
      ERROR_CODES.REPO_PATH_TRAVERSAL,
    );
    await expectRejected(policy, `${join(root, 'repo')}\0`, ERROR_CODES.REPO_PATH_INVALID);
    await expectRejected(policy, '   ', ERROR_CODES.REPO_PATH_INVALID);
  });

  it('rejects UNC paths unless explicitly enabled, and device paths unconditionally', async () => {
    const root = await makeRoot();
    await initRepo(join(root, 'repo'));

    if (process.platform === 'win32') {
      const policy = policyFor(root);
      for (const devicePath of [
        '\\\\?\\C:\\repo',
        '\\\\.\\PhysicalDrive0',
        '\\\\?\\UNC\\server\\share',
        '//?/C:/repo',
      ]) {
        await expectRejected(policy, devicePath, ERROR_CODES.REPO_PATH_INVALID);
        await expectRejected(
          policyFor(root, { allowedRepositoryRoots: [] }),
          devicePath,
          ERROR_CODES.REPO_PATH_INVALID,
        );
      }

      const unc = await policy.validate('\\\\server\\share\\repo');
      expect(unc.ok).toBe(false);
      expect(unc.errorCode).toBe(ERROR_CODES.REPO_UNC_NOT_ALLOWED);

      const optIn = policyFor(root, { allowUnc: true });
      await expectRejected(optIn, '\\\\?\\UNC\\server\\share', ERROR_CODES.REPO_PATH_INVALID);
    }
  });

  it('rejects nonexistent paths, files and paths outside the allowed root', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'allowed'), { recursive: true });
    await writeFile(join(root, 'file.txt'), 'not a directory\n', 'utf8');
    const outside = await initRepo(join(root, 'outside', 'repo'));
    const sibling = await initRepo(join(root, 'repos-evil', 'repo'));
    const policy = policyFor(root, {
      allowedRepositoryRoots: [join(root, 'allowed')],
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
    });

    await expectRejected(policy, join(root, 'missing'), ERROR_CODES.REPO_PATH_NOT_FOUND);
    await expectRejected(policy, join(root, 'file.txt'), ERROR_CODES.REPO_PATH_INVALID);
    await expectRejected(policy, outside, ERROR_CODES.REPO_PATH_OUTSIDE_ALLOWED_ROOTS);

    const siblingPolicy = policyFor(root, {
      allowedRepositoryRoots: [join(root, 'repos')],
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
    });
    await expectRejected(siblingPolicy, sibling, ERROR_CODES.REPO_PATH_OUTSIDE_ALLOWED_ROOTS);
  });

  it('follows a junction/symlink that escapes the allowed root', async (context) => {
    const root = await makeRoot();
    const allowed = join(root, 'allowed');
    await mkdir(allowed, { recursive: true });
    const outside = await initRepo(join(root, 'outside', 'repo'));
    const link = join(allowed, 'escaping-link');
    if (!(await createDirectoryLink(outside, link))) {
      context.skip();
      return;
    }
    const policy = policyFor(root, {
      allowedRepositoryRoots: [allowed],
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
    });
    await expectRejected(policy, link, ERROR_CODES.REPO_PATH_OUTSIDE_ALLOWED_ROOTS);
  });

  it('handles Windows case-insensitive paths without lowering the canonical path', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));

    if (process.platform === 'win32') {
      const policy = policyFor(root, {
        allowedRepositoryRoots: [root.toUpperCase()],
      });
      const result = await policy.validate(repo.toUpperCase());
      expect(result.ok).toBe(true);
      expect(result.canonicalPath).toBe(repo);
    } else {
      const result = await policyFor(root).validate(repo.toUpperCase());
      expect(result.ok).toBe(false);
      expect([
        ERROR_CODES.REPO_PATH_NOT_FOUND,
        ERROR_CODES.REPO_PATH_OUTSIDE_ALLOWED_ROOTS,
      ]).toContain(result.errorCode);
    }
  });
});

describe('RepositoryPathPolicy Git shape checks', () => {
  it('rejects a non-Git directory and a bare repository', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'plain'), { recursive: true });
    const bare = join(root, 'bare.git');
    await mkdir(bare, { recursive: true });
    git(bare, ['init', '--bare']);

    const policy = policyFor(root);
    await expectRejected(policy, join(root, 'plain'), ERROR_CODES.REPO_NOT_GIT_ROOT);
    await expectRejected(policy, bare, ERROR_CODES.REPO_BARE_UNSUPPORTED);
  });

  it('rejects a Git repository subdirectory even though it is inside a repository', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const subdirectory = join(repo, 'packages', 'app');
    await mkdir(subdirectory, { recursive: true });
    await expectRejected(policyFor(root), subdirectory, ERROR_CODES.REPO_NOT_GIT_ROOT);
  });

  it('rejects a linked worktree and a submodule', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const linked = join(root, 'linked');
    git(repo, ['worktree', 'add', '-b', 'linked-fixture', linked]);
    const policy = policyFor(root);
    await expectRejected(policy, linked, ERROR_CODES.REPO_PATH_IS_WORKTREE);

    const child = await initRepo(join(root, 'child-repo'));
    const parent = await initRepo(join(root, 'parent-repo'));
    git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'modules/child']);
    git(parent, [
      '-c',
      'user.name=Haft Test',
      '-c',
      'user.email=haft-test@example.com',
      'commit',
      '-m',
      'add submodule',
    ]);
    await expectRejected(
      policy,
      join(parent, 'modules', 'child'),
      ERROR_CODES.REPO_PATH_IS_WORKTREE,
    );
  });

  it('rejects an empty repository with no HEAD', async () => {
    const root = await makeRoot();
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });
    git(empty, ['init']);
    await expectRejected(policyFor(root), empty, ERROR_CODES.REPO_VALIDATION_FAILED);
  });
});

describe('RepositoryPathPolicy bidirectional isolation', () => {
  it('rejects a repository inside worktreeRoot or recoveryRoot', async () => {
    const root = await makeRoot();
    const inWorktree = await initRepo(join(root, 'worktrees', 'repo'));
    await expectRejected(
      policyFor(root, {
        worktreeRoot: join(root, 'worktrees'),
        recoveryRoot: join(root, 'recovery'),
      }),
      inWorktree,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );

    const inRecovery = await initRepo(join(root, 'recovery', 'repo'));
    await expectRejected(
      policyFor(root, {
        worktreeRoot: join(root, 'worktrees'),
        recoveryRoot: join(root, 'recovery'),
      }),
      inRecovery,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );
  });

  it('rejects worktreeRoot or recoveryRoot inside the repository', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    await expectRejected(
      policyFor(root, {
        worktreeRoot: join(repo, 'worktrees'),
        recoveryRoot: join(root, 'recovery'),
      }),
      repo,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );
    await expectRejected(
      policyFor(root, {
        worktreeRoot: join(root, 'worktrees'),
        recoveryRoot: join(repo, 'recovery'),
      }),
      repo,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );
  });

  it('treats repo === worktreeRoot and repo === recoveryRoot as overlap', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    expect(repo).toBeTruthy();
    await expectRejected(
      policyFor(root, {
        worktreeRoot: repo,
        recoveryRoot: join(root, 'recovery'),
      }),
      repo,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );
    await expectRejected(
      policyFor(root, {
        worktreeRoot: join(root, 'worktrees'),
        recoveryRoot: repo,
      }),
      repo,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );
  });

  it('rejects overlapping worktreeRoot and recoveryRoot as a policy configuration error', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    for (const [worktreeRoot, recoveryRoot] of [
      [join(root, 'shared'), join(root, 'shared')],
      [join(root, 'shared', 'worktrees'), join(root, 'shared')],
      [join(root, 'shared'), join(root, 'shared', 'recovery')],
    ]) {
      const policy = policyFor(root, { worktreeRoot, recoveryRoot });
      expect(policy.configError).toBe(ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED);
      const result = await policy.validate(repo);
      expect(result.errorCode).toBe(ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED);
    }
  });

  it('accepts a repository and roots that are mutually disjoint', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const result = await policyFor(root, {
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
    }).validate(repo);
    expect(result).toMatchObject({ ok: true, canonicalPath: repo });
  });

  it('uses realpath for roots so a junction cannot hide an overlap', async (context) => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const realWorktreeRoot = join(repo, 'real-worktrees');
    await mkdir(realWorktreeRoot, { recursive: true });
    const worktreeLink = join(root, 'worktree-link');
    if (!(await createDirectoryLink(realWorktreeRoot, worktreeLink))) {
      context.skip();
      return;
    }
    await expectRejected(
      policyFor(root, {
        worktreeRoot: worktreeLink,
        recoveryRoot: join(root, 'recovery'),
      }),
      repo,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );
  });

  it('detects a recoveryRoot junction that points inside the repository', async (context) => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const realRecoveryRoot = join(repo, 'real-recovery');
    await mkdir(realRecoveryRoot, { recursive: true });
    const recoveryLink = join(root, 'recovery-link');
    if (!(await createDirectoryLink(realRecoveryRoot, recoveryLink))) {
      context.skip();
      return;
    }
    await expectRejected(
      policyFor(root, {
        worktreeRoot: join(root, 'worktrees'),
        recoveryRoot: recoveryLink,
      }),
      repo,
      ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    );
  });

  it('fails closed when no allowed root or no absolute root is configured', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    for (const allowedRepositoryRoots of [[], ['relative-root']]) {
      const policy = policyFor(root, { allowedRepositoryRoots });
      expect(policy.configError).toBe(ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED);
      const result = await policy.validate(repo);
      expect(result.errorCode).toBe(ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED);
    }

    for (const [worktreeRoot, recoveryRoot] of [
      ['relative-worktrees', join(root, 'recovery')],
      [join(root, 'worktrees'), 'relative-recovery'],
    ]) {
      const policy = policyFor(root, { worktreeRoot, recoveryRoot });
      expect(policy.configError).toBe(ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED);
    }
  });
});

describe('RepositoryPathPolicy policyVersion', () => {
  it('is stable for identical configuration and independent of root order', async () => {
    const root = await makeRoot();
    const other = join(root, 'other-root');
    const first = policyFor(root, {
      allowedRepositoryRoots: [root, other],
    });
    const second = policyFor(root, {
      allowedRepositoryRoots: [other, root],
    });
    const third = policyFor(root, {
      allowedRepositoryRoots: [root, other],
    });
    expect(second.policyVersion).toBe(first.policyVersion);
    expect(third.policyVersion).toBe(first.policyVersion);
  });

  it('changes when a root, allowUnc, worktreeRoot or recoveryRoot changes', async () => {
    const root = await makeRoot();
    const base = policyFor(root).policyVersion;
    expect(
      policyFor(root, {
        allowedRepositoryRoots: [join(root, 'different-root')],
      }).policyVersion,
    ).not.toBe(base);
    expect(policyFor(root, { allowUnc: true }).policyVersion).not.toBe(base);
    expect(policyFor(root, { worktreeRoot: join(root, 'other-worktrees') }).policyVersion).not.toBe(
      base,
    );
    expect(policyFor(root, { recoveryRoot: join(root, 'other-recovery') }).policyVersion).not.toBe(
      base,
    );
  });

  it('keeps a stable version for invalid overlapping roots', async () => {
    const root = await makeRoot();
    const first = policyFor(root, {
      worktreeRoot: join(root, 'shared'),
      recoveryRoot: join(root, 'shared'),
    });
    const second = policyFor(root, {
      worktreeRoot: join(root, 'shared'),
      recoveryRoot: join(root, 'shared'),
    });
    expect(first.configError).toBe(ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED);
    expect(second.policyVersion).toBe(first.policyVersion);
  });

  it('never exposes allowDevicePaths as a configuration field', async () => {
    const root = await makeRoot();
    const config = baseConfig(root);
    expect('allowDevicePaths' in config).toBe(false);
    const policy = new RepositoryPathPolicy(config);
    expect(policy.configError).toBeNull();
  });

  it('locks the canonical hash input, including allowDevicePaths: false', () => {
    const canonical = serializePolicyVersionInput({
      allowedRepositoryRoots: ['/srv/repos', '/srv/other'],
      allowUnc: false,
      worktreeRoot: '/srv/worktrees',
      recoveryRoot: '/srv/recovery',
    });
    expect(canonical).toBe(
      '{"allowDevicePaths":false,"allowUnc":false,"allowedRepositoryRoots":["/srv/other","/srv/repos"],"recoveryRoot":"/srv/recovery","worktreeRoot":"/srv/worktrees"}',
    );
    expect(createHash('sha256').update(canonical).digest('hex').slice(0, 16)).toBe(
      'db4c97086eb740a2',
    );

    // The same fixed input must always serialize identically, regardless of
    // root order or duplicates.
    expect(
      serializePolicyVersionInput({
        allowedRepositoryRoots: ['/srv/other', '/srv/repos', '/srv/repos'],
        allowUnc: false,
        worktreeRoot: '/srv/worktrees',
        recoveryRoot: '/srv/recovery',
      }),
    ).toBe(canonical);
  });
});

describe('RepositoryPathPolicy assertStillAllowed', () => {
  it('re-runs containment and isolation against an existing canonical path', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const policy = policyFor(root);
    const result = await policy.validate(repo);
    const canonical = result.canonicalPath;
    expect(canonical).toBeTruthy();
    await expect(policy.assertStillAllowed(canonical ?? '')).resolves.toBeUndefined();
  });

  it('detects a moved repository', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const policy = policyFor(root);
    const canonical = (await policy.validate(repo)).canonicalPath ?? '';
    await rename(repo, join(root, 'repo-moved'));
    await expect(policy.assertStillAllowed(canonical)).rejects.toMatchObject({
      code: ERROR_CODES.REPO_PATH_NOT_FOUND,
    });
  });

  it('detects a changed allowed-root policy', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const first = policyFor(root);
    const canonical = (await first.validate(repo)).canonicalPath ?? '';
    const changed = policyFor(root, {
      allowedRepositoryRoots: [join(root, 'different-root')],
    });
    await expect(changed.assertStillAllowed(canonical)).rejects.toMatchObject({
      code: ERROR_CODES.REPO_PATH_OUTSIDE_ALLOWED_ROOTS,
    });
  });

  it('detects a newly overlapping worktreeRoot', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const first = policyFor(root);
    const canonical = (await first.validate(repo)).canonicalPath ?? '';
    const changed = policyFor(root, {
      worktreeRoot: join(repo, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
    });
    await expect(changed.assertStillAllowed(canonical)).rejects.toMatchObject({
      code: ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
    });
  });

  it('detects a path replaced by a link that escapes the allowed root', async (context) => {
    const root = await makeRoot();
    const allowed = join(root, 'allowed');
    await mkdir(allowed, { recursive: true });
    const repo = await initRepo(join(allowed, 'repo'));
    const policy = policyFor(root, {
      allowedRepositoryRoots: [allowed],
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
    });
    const canonical = (await policy.validate(repo)).canonicalPath ?? '';
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const outside = await initRepo(join(root, 'outside', 'repo'));
    if (!(await createDirectoryLink(outside, repo))) {
      context.skip();
      return;
    }
    await expect(policy.assertStillAllowed(canonical)).rejects.toMatchObject({
      code: ERROR_CODES.REPO_PATH_OUTSIDE_ALLOWED_ROOTS,
    });
  });
});

describe('path comparison helpers', () => {
  it('uses path.relative instead of string prefixes', () => {
    expect(containsPath('/repos', '/repos/child', 'linux')).toBe(true);
    expect(containsPath('/repos', '/repos', 'linux')).toBe(true);
    expect(containsPath('/repos', '/repos-evil', 'linux')).toBe(false);
    expect(containsPath('/repos', '/Repos/child', 'linux')).toBe(false);

    expect(containsPath('C:\\Repos', 'C:\\Repos\\child', 'win32')).toBe(true);
    expect(containsPath('C:\\Repos', 'c:\\repos\\child', 'win32')).toBe(true);
    expect(containsPath('C:\\Repos', 'C:\\Repos-evil', 'win32')).toBe(false);
    expect(containsPath('C:\\Repos', 'D:\\Repos', 'win32')).toBe(false);
  });

  it('detects traversal segments and Windows device prefixes explicitly', () => {
    expect(hasTraversalSegment('C:\\repo\\..\\evil')).toBe(true);
    expect(hasTraversalSegment('/repo/../evil')).toBe(true);
    expect(hasTraversalSegment('C:\\repo\\..evil')).toBe(false);
    expect(hasTraversalSegment('C:\\repo\\.hidden')).toBe(false);

    expect(isWindowsDevicePath('\\\\?\\C:\\repo')).toBe(true);
    expect(isWindowsDevicePath('\\\\.\\PhysicalDrive0')).toBe(true);
    expect(isWindowsDevicePath('//?/C:/repo')).toBe(true);
    expect(isWindowsDevicePath('\\\\server\\share\\repo')).toBe(false);
    expect(isWindowsDevicePath('C:\\repo')).toBe(false);
    expect(win32.isAbsolute('C:\\repo')).toBe(true);
  });
});

function baseConfig(root: string): RepositoryPolicyConfig {
  return {
    allowedRepositoryRoots: [root],
    allowUnc: false,
    worktreeRoot: join(root, 'worktrees'),
    recoveryRoot: join(root, 'recovery'),
    gitBinary: 'git',
    platform: process.platform,
  };
}

async function expectRejected(
  policy: RepositoryPathPolicy,
  path: string,
  code: string,
): Promise<void> {
  const result = await policy.validate(path);
  expect(result.ok).toBe(false);
  expect(result.errorCode).toBe(code);
  expect(result.message).toBeTruthy();
}
