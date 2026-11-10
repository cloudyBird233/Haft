import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { posix, win32, type PlatformPath } from 'node:path';
import { ERROR_CODES, type ErrorCode } from '@raft-lite/contracts';
import { buildCliEnvironment } from './process-utils';

export interface RepositoryPolicyConfig {
  allowedRepositoryRoots: string[];
  allowUnc: boolean;
  worktreeRoot: string;
  recoveryRoot: string;
  gitBinary: string;
  platform: NodeJS.Platform;
}

export interface RepositoryValidationResult {
  ok: boolean;
  platform: NodeJS.Platform;
  policyVersion: string;
  canonicalPath?: string;
  headCommit?: string;
  errorCode?: ErrorCode;
  message?: string;
}

export class RepositoryPolicyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RepositoryPolicyError';
  }
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

type IsolationFailure = { code: ErrorCode; message: string };

type GitInspection =
  { ok: true; headCommit: string } | { ok: false; code: ErrorCode; message: string };

type PathCheckResult =
  { ok: true; canonicalPath: string } | { ok: false; code: ErrorCode; message: string };

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The single authority for repository path decisions on the runner host.
 *
 * All real repository paths must pass through `validate()` before an execution
 * context is created, and through `assertStillAllowed()` again immediately
 * before a worktree or recovery-journal write. Device paths are rejected
 * unconditionally; there is no configuration surface that can enable them.
 */
export class RepositoryPathPolicy {
  readonly policyVersion: string;
  readonly configError: ErrorCode | null;
  readonly platform: NodeJS.Platform;
  /** Non-fatal configuration observations for the startup log. */
  readonly warnings: string[];

  private readonly pathApi: PlatformPath;
  private readonly allowedRoots: string[];
  private readonly allowUnc: boolean;
  private readonly worktreeRoot: string;
  private readonly recoveryRoot: string;
  private readonly gitBinary: string;

  constructor(config: RepositoryPolicyConfig) {
    this.platform = config.platform;
    this.pathApi = this.platform === 'win32' ? win32 : posix;
    this.allowUnc = config.allowUnc === true;
    this.gitBinary = config.gitBinary;
    this.allowedRoots = [...config.allowedRepositoryRoots]
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    this.worktreeRoot = config.worktreeRoot;
    this.recoveryRoot = config.recoveryRoot;
    this.warnings = [];

    for (const root of this.allowedRoots) {
      if (!this.pathApi.isAbsolute(root)) {
        this.warnings.push(`Allowed repository root is not absolute and will be ignored: ${root}`);
        continue;
      }
      if (!existsSync(root)) {
        this.warnings.push(`Allowed repository root does not exist yet: ${root}`);
      }
    }
    if (!existsSync(this.worktreeRoot)) {
      this.warnings.push(`worktreeRoot does not exist yet: ${this.worktreeRoot}`);
    }
    if (!existsSync(this.recoveryRoot)) {
      this.warnings.push(`recoveryRoot does not exist yet: ${this.recoveryRoot}`);
    }

    const absoluteAllowedRoots = this.allowedRoots.filter((root) => this.pathApi.isAbsolute(root));
    const worktreeAbsolute = this.pathApi.isAbsolute(this.worktreeRoot);
    const recoveryAbsolute = this.pathApi.isAbsolute(this.recoveryRoot);

    let configError: ErrorCode | null = null;
    if (absoluteAllowedRoots.length === 0) {
      configError = ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED;
    }
    if (!worktreeAbsolute || !recoveryAbsolute) {
      configError = ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED;
    }
    if (configError === null) {
      const worktreeCanonical = canonicalizeRootSync(this.worktreeRoot, this.pathApi);
      const recoveryCanonical = canonicalizeRootSync(this.recoveryRoot, this.pathApi);
      if (
        worktreeCanonical === null ||
        recoveryCanonical === null ||
        pathsOverlap(worktreeCanonical, recoveryCanonical, this.platform)
      ) {
        configError = ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED;
      }
    }
    this.configError = configError;

    this.policyVersion = computePolicyVersion({
      allowedRepositoryRoots: absoluteAllowedRoots,
      allowUnc: this.allowUnc,
      worktreeRoot: this.worktreeRoot,
      recoveryRoot: this.recoveryRoot,
      platform: this.platform,
    });
  }

  /**
   * Path-only repository validation. There is intentionally no default-branch
   * parameter: branch existence belongs to the execution.repository handshake.
   */
  async validate(rawPath: string): Promise<RepositoryValidationResult> {
    const checked = await this.checkPath(rawPath);
    if (!checked.ok) {
      return this.failure(checked.code, checked.message);
    }

    const git = await this.inspectGit(checked.canonicalPath);
    if (!git.ok) {
      return this.failure(git.code, git.message);
    }

    return {
      ok: true,
      platform: this.platform,
      policyVersion: this.policyVersion,
      canonicalPath: checked.canonicalPath,
      headCommit: git.headCommit,
    };
  }

  /**
   * Re-runs configuration, realpath, allowed-root containment and bidirectional
   * worktree/recovery isolation against an already canonical path. This is the
   * TOCTOU mitigation used before worktree creation and recovery-journal
   * writes. It never trusts a previous validation result and intentionally
   * skips the expensive Git-shape commands.
   */
  async assertStillAllowed(canonicalPath: string): Promise<void> {
    const checked = await this.checkPath(canonicalPath);
    if (!checked.ok) {
      throw new RepositoryPolicyError(checked.code, checked.message);
    }
    if (!samePath(checked.canonicalPath, canonicalPath, this.platform)) {
      throw new RepositoryPolicyError(
        ERROR_CODES.REPO_PATH_INVALID,
        'Repository path no longer resolves to the validated canonical path',
      );
    }
  }

  private async checkPath(rawPath: string): Promise<PathCheckResult> {
    // Device paths are rejected before configuration is consulted: no policy,
    // allowed root, UNC opt-in or extra property can ever authorize them.
    if (this.platform === 'win32' && typeof rawPath === 'string' && isWindowsDevicePath(rawPath)) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_INVALID,
        message: 'Windows device paths are always rejected',
      };
    }
    if (this.configError) {
      return {
        ok: false,
        code: this.configError,
        message: this.describeConfigError(this.configError),
      };
    }

    const inputFailure = this.validateInput(rawPath);
    if (inputFailure) {
      return { ok: false, ...inputFailure };
    }

    if (this.platform === 'win32' && isUncPath(rawPath) && !this.allowUnc) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_UNC_NOT_ALLOWED,
        message: 'UNC repository paths are disabled on this runner',
      };
    }
    if (!this.pathApi.isAbsolute(rawPath)) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_NOT_ABSOLUTE,
        message: 'Repository path must be absolute on the runner host',
      };
    }
    if (hasTraversalSegment(rawPath)) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_TRAVERSAL,
        message: 'Repository path must not contain a ".." segment',
      };
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(rawPath);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        return {
          ok: false,
          code: ERROR_CODES.REPO_PATH_NOT_FOUND,
          message: 'Repository path does not exist on the runner host',
        };
      }
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_INVALID,
        message: `Repository path could not be resolved: ${errorMessage(error)}`,
      };
    }

    try {
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) {
        return {
          ok: false,
          code: ERROR_CODES.REPO_PATH_INVALID,
          message: 'Repository path must be a directory',
        };
      }
    } catch (error) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_INVALID,
        message: `Repository path could not be inspected: ${errorMessage(error)}`,
      };
    }

    if (!(await this.isInsideAllowedRoot(canonicalPath))) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_OUTSIDE_ALLOWED_ROOTS,
        message: 'Repository path is outside the configured allowed roots',
      };
    }

    const isolation = await this.isolationFailure(canonicalPath);
    if (isolation) {
      return { ok: false, code: isolation.code, message: isolation.message };
    }

    return { ok: true, canonicalPath };
  }

  private validateInput(rawPath: string): { code: ErrorCode; message: string } | null {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return { code: ERROR_CODES.REPO_PATH_INVALID, message: 'Repository path is empty' };
    }
    if (rawPath.includes('\0')) {
      return {
        code: ERROR_CODES.REPO_PATH_INVALID,
        message: 'Repository path contains a NUL character',
      };
    }
    if (this.platform === 'win32' && isWindowsDevicePath(rawPath)) {
      return {
        code: ERROR_CODES.REPO_PATH_INVALID,
        message: 'Windows device paths are always rejected',
      };
    }
    return null;
  }

  private async isInsideAllowedRoot(canonicalPath: string): Promise<boolean> {
    for (const root of this.allowedRoots) {
      if (!this.pathApi.isAbsolute(root)) continue;
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root);
      } catch {
        // A root that cannot be resolved cannot authorize a repository.
        continue;
      }
      if (containsPath(canonicalRoot, canonicalPath, this.platform)) {
        return true;
      }
    }
    return false;
  }

  private async isolationFailure(canonicalPath: string): Promise<IsolationFailure | null> {
    let worktreeCanonical: string | null;
    let recoveryCanonical: string | null;
    try {
      worktreeCanonical = await canonicalizeRoot(this.worktreeRoot, this.pathApi);
      recoveryCanonical = await canonicalizeRoot(this.recoveryRoot, this.pathApi);
    } catch (error) {
      return {
        code: ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED,
        message: `Runner worktree/recovery roots could not be resolved: ${errorMessage(error)}`,
      };
    }
    if (worktreeCanonical === null || recoveryCanonical === null) {
      return {
        code: ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED,
        message: 'Runner worktree/recovery roots could not be resolved',
      };
    }

    if (pathsOverlap(worktreeCanonical, recoveryCanonical, this.platform)) {
      return {
        code: ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED,
        message: 'worktreeRoot and recoveryRoot must not overlap',
      };
    }
    if (containsPath(worktreeCanonical, canonicalPath, this.platform)) {
      return {
        code: ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
        message: 'repository is inside worktreeRoot',
      };
    }
    if (containsPath(recoveryCanonical, canonicalPath, this.platform)) {
      return {
        code: ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
        message: 'repository is inside recoveryRoot',
      };
    }
    if (containsPath(canonicalPath, worktreeCanonical, this.platform)) {
      return {
        code: ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
        message: 'worktreeRoot is inside repository',
      };
    }
    if (containsPath(canonicalPath, recoveryCanonical, this.platform)) {
      return {
        code: ERROR_CODES.REPO_PATH_NESTED_IN_WORKTREE_ROOT,
        message: 'recoveryRoot is inside repository',
      };
    }
    return null;
  }

  private async inspectGit(canonicalPath: string): Promise<GitInspection> {
    const bare = await this.runGit(canonicalPath, ['rev-parse', '--is-bare-repository']);
    if (bare.spawnError) {
      return this.gitUnavailable(bare);
    }
    if (bare.code === 0 && bare.stdout.trim().toLowerCase() === 'true') {
      return {
        ok: false,
        code: ERROR_CODES.REPO_BARE_UNSUPPORTED,
        message: 'Bare repositories are not supported',
      };
    }

    const top = await this.runGit(canonicalPath, ['rev-parse', '--show-toplevel']);
    if (top.spawnError) {
      return this.gitUnavailable(top);
    }
    if (top.code !== 0 || top.stdout.trim().length === 0) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_NOT_GIT_ROOT,
        message: 'Repository path is not the root of a Git repository',
      };
    }
    const topCanonical = await safeRealpath(top.stdout.trim());
    if (topCanonical === null || !samePath(topCanonical, canonicalPath, this.platform)) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_NOT_GIT_ROOT,
        message: 'Repository path is not the root of a Git repository',
      };
    }

    const superproject = await this.runGit(canonicalPath, [
      'rev-parse',
      '--show-superproject-working-tree',
    ]);
    if (superproject.spawnError) {
      return this.gitUnavailable(superproject);
    }
    if (superproject.code !== 0) {
      return this.gitCommandFailed(superproject);
    }
    if (superproject.stdout.trim().length > 0) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_IS_WORKTREE,
        message: 'Submodules are not supported; bind the main checkout',
      };
    }

    const gitDir = await this.runGit(canonicalPath, ['rev-parse', '--git-dir']);
    const commonDir = await this.runGit(canonicalPath, ['rev-parse', '--git-common-dir']);
    if (gitDir.spawnError) {
      return this.gitUnavailable(gitDir);
    }
    if (commonDir.spawnError) {
      return this.gitUnavailable(commonDir);
    }
    if (
      gitDir.code !== 0 ||
      commonDir.code !== 0 ||
      gitDir.stdout.trim().length === 0 ||
      commonDir.stdout.trim().length === 0
    ) {
      return this.gitCommandFailed(gitDir.code !== 0 ? gitDir : commonDir);
    }
    const gitDirCanonical = await safeRealpath(
      this.resolveGitPath(canonicalPath, gitDir.stdout.trim()),
    );
    const commonDirCanonical = await safeRealpath(
      this.resolveGitPath(canonicalPath, commonDir.stdout.trim()),
    );
    if (gitDirCanonical === null || commonDirCanonical === null) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_VALIDATION_FAILED,
        message: 'Git metadata directories could not be resolved',
      };
    }
    if (!samePath(gitDirCanonical, commonDirCanonical, this.platform)) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_PATH_IS_WORKTREE,
        message: 'Linked worktrees are not supported; bind the main checkout',
      };
    }

    const head = await this.runGit(canonicalPath, ['rev-parse', 'HEAD']);
    if (head.spawnError) {
      return this.gitUnavailable(head);
    }
    if (head.code !== 0 || head.stdout.trim().length === 0) {
      return {
        ok: false,
        code: ERROR_CODES.REPO_VALIDATION_FAILED,
        message: 'Repository has no valid HEAD commit',
      };
    }
    return { ok: true, headCommit: head.stdout.trim() };
  }

  private resolveGitPath(canonicalPath: string, value: string): string {
    return this.pathApi.isAbsolute(value)
      ? this.pathApi.normalize(value)
      : this.pathApi.resolve(canonicalPath, value);
  }

  private runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
    return new Promise((resolvePromise) => {
      execFile(
        this.gitBinary,
        ['-C', cwd, ...args],
        {
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_OUTPUT_BYTES,
          windowsHide: true,
          env: {
            ...buildCliEnvironment(),
            GIT_TERMINAL_PROMPT: '0',
            GIT_PAGER: 'cat',
          },
        },
        (error, stdout, stderr) => {
          const output = {
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
          };
          if (!error) {
            resolvePromise({ code: 0, ...output, spawnError: null });
            return;
          }
          const rawCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          const numericCode = typeof rawCode === 'number' ? rawCode : null;
          resolvePromise({
            code: numericCode,
            ...output,
            spawnError: numericCode === null ? error : null,
          });
        },
      );
    });
  }

  private gitUnavailable(result: GitResult): GitInspection {
    return {
      ok: false,
      code: ERROR_CODES.REPO_VALIDATION_FAILED,
      message: `Git could not inspect the repository: ${errorMessage(
        result.spawnError ?? new Error(result.stderr || 'unknown Git error'),
      )}`,
    };
  }

  private gitCommandFailed(result: GitResult): GitInspection {
    return {
      ok: false,
      code: ERROR_CODES.REPO_VALIDATION_FAILED,
      message: `Git inspection failed: ${result.stderr.trim() || 'unknown Git error'}`,
    };
  }

  private describeConfigError(code: ErrorCode): string {
    if (code === ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED) {
      return 'Configure at least one absolute allowed repository root and make worktreeRoot/recoveryRoot absolute, mutually disjoint directories';
    }
    return 'Runner repository path policy is not configured';
  }

  private failure(code: ErrorCode, message: string): RepositoryValidationResult {
    return {
      ok: false,
      platform: this.platform,
      policyVersion: this.policyVersion,
      errorCode: code,
      message,
    };
  }
}

export function containsPath(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? win32 : posix;
  const relativePath = pathApi.relative(pathApi.normalize(root), pathApi.normalize(target));
  if (relativePath === '') return true;
  if (pathApi.isAbsolute(relativePath)) return false;
  return relativePath !== '..' && !relativePath.startsWith(`..${pathApi.sep}`);
}

export function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

export function isWindowsDevicePath(value: string): boolean {
  return /^\\\\[?.]\\/.test(value.replace(/\//g, '\\'));
}

function isUncPath(value: string): boolean {
  return value.replace(/\//g, '\\').startsWith('\\\\');
}

function pathsOverlap(a: string, b: string, platform: NodeJS.Platform): boolean {
  return containsPath(a, b, platform) || containsPath(b, a, platform);
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return containsPath(a, b, platform) && containsPath(b, a, platform);
}

function computePolicyVersion(input: {
  allowedRepositoryRoots: string[];
  allowUnc: boolean;
  worktreeRoot: string;
  recoveryRoot: string;
  platform: NodeJS.Platform;
}): string {
  const pathApi = input.platform === 'win32' ? win32 : posix;
  const normalizedRoots = [
    ...new Set(input.allowedRepositoryRoots.map((root) => normalizeForPolicy(root, pathApi))),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const canonical = {
    allowDevicePaths: false,
    allowUnc: input.allowUnc,
    allowedRepositoryRoots: normalizedRoots,
    recoveryRoot: normalizeForPolicy(input.recoveryRoot, pathApi),
    worktreeRoot: normalizeForPolicy(input.worktreeRoot, pathApi),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function normalizeForPolicy(value: string, pathApi: PlatformPath): string {
  if (!pathApi.isAbsolute(value)) {
    return pathApi.normalize(value);
  }
  return canonicalizeRootSync(value, pathApi) ?? pathApi.normalize(value);
}

/**
 * Realpath the longest existing prefix and append the non-existing remainder.
 * This prevents a parent junction/symlink from hiding an overlap when the
 * worktree or recovery root has not been created yet.
 */
function canonicalizeRootSync(root: string, pathApi: PlatformPath): string | null {
  const resolved = pathApi.resolve(root);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const actual = realpathSync(current);
      return pathApi.join(actual, ...missing.reverse());
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return null;
      }
      const parent = pathApi.dirname(current);
      if (parent === current) {
        return pathApi.normalize(resolved);
      }
      missing.push(pathApi.basename(current));
      current = parent;
    }
  }
}

async function canonicalizeRoot(root: string, pathApi: PlatformPath): Promise<string | null> {
  const resolved = pathApi.resolve(root);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const actual = await realpath(current);
      return pathApi.join(actual, ...missing.reverse());
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return null;
      }
      const parent = pathApi.dirname(current);
      if (parent === current) {
        return pathApi.normalize(resolved);
      }
      missing.push(pathApi.basename(current));
      current = parent;
    }
  }
}

async function safeRealpath(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
