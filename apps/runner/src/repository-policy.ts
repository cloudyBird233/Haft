import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * P2-01 implements the frozen P2-02 path policy vocabulary for
 * `repository.validate`. Execution-time handshakes remain P2-02 scope; the
 * policy module is shared by both so the rules cannot drift.
 */
export const REPOSITORY_POLICY_VERSION_PREFIX = 'repository-path-policy-v1';

export const REPOSITORY_POLICY_ERROR_CODES = [
  'REPOSITORY_POLICY_NOT_CONFIGURED',
  'REPO_PATH_INVALID',
  'REPO_PATH_NOT_ABSOLUTE',
  'REPO_PATH_TRAVERSAL',
  'REPO_UNC_NOT_ALLOWED',
  'REPO_PATH_OUTSIDE_ALLOWED_ROOTS',
  'REPO_PATH_NOT_FOUND',
  'REPO_NOT_GIT_ROOT',
  'REPO_BARE_UNSUPPORTED',
  'REPO_PATH_IS_WORKTREE',
  'REPO_PATH_NESTED_IN_WORKTREE_ROOT',
  'REPO_DEFAULT_BRANCH_NOT_FOUND',
  'REPO_VALIDATION_FAILED',
] as const;

export type RepositoryPolicyErrorCode = (typeof REPOSITORY_POLICY_ERROR_CODES)[number];

export interface RepositoryPolicyConfig {
  allowedRepositoryRoots: string[];
  worktreeRoot: string;
  recoveryRoot: string;
  gitBinary: string;
}

export interface RepositoryValidationSuccess {
  ok: true;
  canonicalPath: string;
  platform: string;
  policyVersion: string;
  headCommit: string;
}

export interface RepositoryValidationFailure {
  ok: false;
  platform: string;
  policyVersion: string;
  errorCode: RepositoryPolicyErrorCode;
  message: string;
}

export type RepositoryValidationResult = RepositoryValidationSuccess | RepositoryValidationFailure;

export class RepositoryPolicyError extends Error {
  readonly code: RepositoryPolicyErrorCode;

  constructor(code: RepositoryPolicyErrorCode, message: string) {
    super(message);
    this.name = 'RepositoryPolicyError';
    this.code = code;
  }
}

/**
 * The version is a hash over the policy inputs that decide whether a path is
 * acceptable. Changing an allowed root, the worktree quarantine area, or a
 * future policy switch must invalidate previous validations.
 */
export function repositoryPolicyVersion(config: RepositoryPolicyConfig): string {
  const normalized = {
    allowedRepositoryRoots: config.allowedRepositoryRoots
      .map((root) => normalizeForComparison(resolve(root)))
      .sort(),
    allowUnc: false,
    allowDevicePaths: false,
    worktreeRoot: normalizeForComparison(resolve(config.worktreeRoot)),
    recoveryRoot: normalizeForComparison(resolve(config.recoveryRoot)),
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Validates that `input` is a real Git main-worktree root inside the configured
 * allowed roots. All comparisons run on `realpath` results with
 * `path.relative`, never on string prefixes, so symlink and junction escapes
 * cannot be smuggled through a shared prefix such as `/srv/repo-evil`.
 */
export async function validateRepositoryPath(
  input: string,
  config: RepositoryPolicyConfig,
): Promise<RepositoryValidationResult> {
  const policyVersion = repositoryPolicyVersion(config);
  const platform = process.platform;
  try {
    const canonicalPath = await resolveValidatedPath(input, config);
    const headCommit = await readHeadCommit(canonicalPath, config.gitBinary);
    return {
      ok: true,
      canonicalPath,
      platform,
      policyVersion,
      headCommit,
    };
  } catch (error) {
    if (error instanceof RepositoryPolicyError) {
      return {
        ok: false,
        platform,
        policyVersion,
        errorCode: error.code,
        message: error.message,
      };
    }
    return {
      ok: false,
      platform,
      policyVersion,
      errorCode: 'REPO_VALIDATION_FAILED',
      message: error instanceof Error ? error.message : 'Repository validation failed',
    };
  }
}

async function resolveValidatedPath(
  input: string,
  config: RepositoryPolicyConfig,
): Promise<string> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new RepositoryPolicyError('REPO_PATH_INVALID', 'Repository path is empty');
  }
  if (input.includes('\0')) {
    throw new RepositoryPolicyError('REPO_PATH_INVALID', 'Repository path contains NUL');
  }
  if (/^[\\/]{2}[?.][\\/]/.test(input)) {
    throw new RepositoryPolicyError(
      'REPO_PATH_INVALID',
      'Windows device paths are not allowed as repository paths',
    );
  }
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    throw new RepositoryPolicyError('REPO_UNC_NOT_ALLOWED', 'UNC repository paths are not allowed');
  }
  if (!isAbsolute(input)) {
    throw new RepositoryPolicyError('REPO_PATH_NOT_ABSOLUTE', 'Repository path must be absolute');
  }
  if (input.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new RepositoryPolicyError(
      'REPO_PATH_TRAVERSAL',
      'Repository path must not contain ".." segments',
    );
  }
  if (config.allowedRepositoryRoots.length === 0) {
    throw new RepositoryPolicyError(
      'REPOSITORY_POLICY_NOT_CONFIGURED',
      'No allowed repository roots are configured on this runner',
    );
  }

  // Only ENOENT means "missing". Permission or I/O failures are validation
  // errors, otherwise a path that exists but cannot be inspected would be
  // reported as absent in the binding status.
  const canonicalPath = await realpathOrThrow(input, 'REPO_VALIDATION_FAILED');
  const targetStats = await stat(canonicalPath).catch((error: unknown) => {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT') {
      throw new RepositoryPolicyError('REPO_PATH_NOT_FOUND', 'Repository path does not exist');
    }
    throw new RepositoryPolicyError(
      'REPO_VALIDATION_FAILED',
      'Repository path cannot be inspected',
    );
  });
  if (!targetStats.isDirectory()) {
    throw new RepositoryPolicyError('REPO_PATH_INVALID', 'Repository path is not a directory');
  }

  const allowedRoots: string[] = [];
  for (const root of config.allowedRepositoryRoots) {
    const canonicalRoot = await realpath(root).catch(() => null);
    if (canonicalRoot) {
      allowedRoots.push(canonicalRoot);
    }
  }
  if (!allowedRoots.some((root) => isSameOrInside(canonicalPath, root))) {
    throw new RepositoryPolicyError(
      'REPO_PATH_OUTSIDE_ALLOWED_ROOTS',
      'Repository path is outside the runner allowed roots',
    );
  }

  for (const quarantined of [config.worktreeRoot, config.recoveryRoot]) {
    const canonicalQuarantine =
      (await realpath(quarantined).catch(() => null)) ?? resolve(quarantined);
    if (isSameOrInside(canonicalPath, canonicalQuarantine)) {
      throw new RepositoryPolicyError(
        'REPO_PATH_NESTED_IN_WORKTREE_ROOT',
        'Repository path must not be inside the runner worktree or recovery root',
      );
    }
  }

  await assertGitMainWorktree(canonicalPath, config.gitBinary);
  return canonicalPath;
}

async function assertGitMainWorktree(canonicalPath: string, gitBinary: string): Promise<void> {
  const isBare = await git(canonicalPath, gitBinary, ['rev-parse', '--is-bare-repository']).catch(
    () => {
      throw new RepositoryPolicyError(
        'REPO_NOT_GIT_ROOT',
        'Repository path is not a Git worktree root',
      );
    },
  );
  if (isBare === 'true') {
    throw new RepositoryPolicyError(
      'REPO_BARE_UNSUPPORTED',
      'Bare repositories cannot be used as an execution workspace',
    );
  }
  const insideWorkTree = await git(canonicalPath, gitBinary, [
    'rev-parse',
    '--is-inside-work-tree',
  ]).catch(() => 'false');
  if (insideWorkTree !== 'true') {
    throw new RepositoryPolicyError(
      'REPO_NOT_GIT_ROOT',
      'Repository path is not a Git worktree root',
    );
  }
  const topLevel = await git(canonicalPath, gitBinary, ['rev-parse', '--show-toplevel']).catch(
    () => {
      throw new RepositoryPolicyError(
        'REPO_NOT_GIT_ROOT',
        'Repository path is not a Git worktree root',
      );
    },
  );
  const canonicalTopLevel = await realpathOrThrow(topLevel, 'REPO_NOT_GIT_ROOT');
  if (!samePath(canonicalTopLevel, canonicalPath)) {
    throw new RepositoryPolicyError(
      'REPO_NOT_GIT_ROOT',
      'Repository path must be the root of the Git main worktree',
    );
  }

  const superProject = await git(canonicalPath, gitBinary, [
    'rev-parse',
    '--show-superproject-working-tree',
  ]).catch(() => '');
  if (superProject.length > 0) {
    throw new RepositoryPolicyError(
      'REPO_PATH_IS_WORKTREE',
      'Submodule working trees cannot be used as a repository root',
    );
  }

  const [gitDir, commonDir] = await Promise.all([
    git(canonicalPath, gitBinary, ['rev-parse', '--git-dir']),
    git(canonicalPath, gitBinary, ['rev-parse', '--git-common-dir']).catch(() => ''),
  ]);
  if (commonDir.length > 0) {
    const resolvedGitDir = await realpathOrThrow(
      resolve(canonicalPath, gitDir),
      'REPO_PATH_IS_WORKTREE',
    );
    const resolvedCommonDir = await realpathOrThrow(
      resolve(canonicalPath, commonDir),
      'REPO_PATH_IS_WORKTREE',
    );
    if (!samePath(resolvedGitDir, resolvedCommonDir)) {
      throw new RepositoryPolicyError(
        'REPO_PATH_IS_WORKTREE',
        'Linked Git worktrees cannot be used as a repository root',
      );
    }
  }
}

async function readHeadCommit(canonicalPath: string, gitBinary: string): Promise<string> {
  const headCommit = await git(canonicalPath, gitBinary, ['rev-parse', 'HEAD']).catch(() => {
    throw new RepositoryPolicyError(
      'REPO_VALIDATION_FAILED',
      'The repository has no readable HEAD commit',
    );
  });
  if (!/^[0-9a-f]{7,64}$/i.test(headCommit)) {
    throw new RepositoryPolicyError(
      'REPO_VALIDATION_FAILED',
      'The repository HEAD commit is not a valid object id',
    );
  }
  return headCommit;
}

async function git(cwd: string, binary: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(binary, args, {
    cwd,
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function realpathOrThrow(path: string, code: RepositoryPolicyErrorCode): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT') {
      throw new RepositoryPolicyError('REPO_PATH_NOT_FOUND', 'Repository path does not exist');
    }
    throw new RepositoryPolicyError(code, 'Repository path cannot be resolved');
  }
}

function isSameOrInside(target: string, root: string): boolean {
  const relation = relative(root, target);
  if (relation === '') return true;
  if (relation === '..' || relation.startsWith(`..${sep}`)) return false;
  return !isAbsolute(relation);
}

function samePath(left: string, right: string): boolean {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

function normalizeForComparison(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
