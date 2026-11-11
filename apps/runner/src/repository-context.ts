import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  ERROR_CODE_VALUES,
  type ErrorCode,
  type ExecutionRepositoryPayload,
} from '@raft-lite/contracts';
import type { RunnerConfig } from './config';
import type { RepositoryPathPolicy } from './repository-policy';

export interface RepositoryContext {
  contextId: string;
  executionId: string;
  projectId: string;
  bindingId: string;
  bindingVersion: number;
  policyVersion: string;
  configuredPath: string;
  canonicalPath: string;
  defaultBranch: string;
  baseCommit: string;
  state: 'ready' | 'starting' | 'started';
  createdAt: number;
  lastUsedAt: number;
}

export class RepositoryContextError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryContextError';
  }
}

const PRE_START_TTL_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * In-memory repository context lifecycle for the execution handshake.
 *
 * `prepare` is the only P2-02 stage that checks `Project.defaultBranch`
 * existence. It never spawns a CLI and never touches the main checkout.
 * Contexts do not survive a runner process restart; the API must resend
 * `execution.repository`.
 */
export class RepositoryContextManager {
  private readonly contexts = new Map<string, RepositoryContext>();

  constructor(
    private readonly config: Pick<
      RunnerConfig,
      'gitBinary' | 'worktreeRoot' | 'recoveryRoot' | 'platform'
    >,
    private readonly policy: RepositoryPathPolicy | null,
  ) {}

  async prepare(payload: ExecutionRepositoryPayload): Promise<RepositoryContext> {
    const existing = this.contexts.get(payload.executionId);
    if (existing) {
      if (this.matches(existing, payload)) {
        existing.lastUsedAt = Date.now();
        return existing;
      }
      throw new RepositoryContextError(
        ERROR_CODES.REPOSITORY_CONTEXT_CONFLICT,
        'The execution id is already bound to a different repository context',
      );
    }

    if (!this.policy) {
      throw new RepositoryContextError(
        ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED,
        'The runner has no repository path policy',
      );
    }
    if (payload.policyVersion !== this.policy.policyVersion) {
      throw new RepositoryContextError(
        ERROR_CODES.REPOSITORY_POLICY_CHANGED,
        'The binding was validated under a different path policy; revalidate it',
      );
    }

    const validation = await this.policy.validate(payload.path);
    if (!validation.ok || !validation.canonicalPath || !validation.headCommit) {
      throw new RepositoryContextError(
        validation.errorCode ?? ERROR_CODES.REPOSITORY_CONTEXT_REJECTED,
        validation.message ?? 'Repository path validation failed',
      );
    }

    await this.assertDefaultBranch(validation.canonicalPath, payload.defaultBranch);
    // Re-run isolation immediately before storing the context (TOCTOU).
    try {
      await this.policy.assertStillAllowed(validation.canonicalPath);
    } catch (error) {
      throw new RepositoryContextError(
        errorCode(error) ?? ERROR_CODES.REPOSITORY_CONTEXT_REJECTED,
        errorMessage(error),
      );
    }

    const baseCommit = await this.branchCommit(validation.canonicalPath, payload.defaultBranch);
    const now = Date.now();
    const context: RepositoryContext = {
      contextId: randomUUID(),
      executionId: payload.executionId,
      projectId: payload.projectId,
      bindingId: payload.bindingId,
      bindingVersion: payload.bindingVersion,
      policyVersion: payload.policyVersion,
      configuredPath: payload.path,
      canonicalPath: validation.canonicalPath,
      defaultBranch: payload.defaultBranch,
      baseCommit,
      state: 'ready',
      createdAt: now,
      lastUsedAt: now,
    };
    this.contexts.set(context.executionId, context);
    return context;
  }

  beginStart(executionId: string): 'acquired' | 'starting' | 'started' | 'missing' {
    const context = this.contexts.get(executionId);
    if (!context) return 'missing';
    context.lastUsedAt = Date.now();
    if (context.state === 'started') return 'started';
    if (context.state === 'starting') return 'starting';
    context.state = 'starting';
    return 'acquired';
  }

  markStarted(executionId: string): void {
    const context = this.contexts.get(executionId);
    if (!context) return;
    context.state = 'started';
    context.lastUsedAt = Date.now();
  }

  release(executionId: string): void {
    this.contexts.delete(executionId);
  }

  get(executionId: string): RepositoryContext | null {
    const context = this.contexts.get(executionId);
    return context ? { ...context } : null;
  }

  /** Sweeps only unused `ready` contexts; started contexts are exempt. */
  sweep(now: number = Date.now()): void {
    for (const [executionId, context] of this.contexts) {
      if (context.state !== 'ready') continue;
      if (now - context.lastUsedAt >= PRE_START_TTL_MS) {
        this.contexts.delete(executionId);
      }
    }
  }

  private matches(context: RepositoryContext, payload: ExecutionRepositoryPayload): boolean {
    return (
      context.projectId === payload.projectId &&
      context.bindingId === payload.bindingId &&
      context.bindingVersion === payload.bindingVersion &&
      context.policyVersion === payload.policyVersion &&
      context.defaultBranch === payload.defaultBranch &&
      comparable(context.configuredPath, this.config.platform) ===
        comparable(payload.path, this.config.platform)
    );
  }

  /**
   * The mandatory default-branch existence check. Both commands receive the
   * branch expression as a single argv element; no shell interpolation.
   */
  private async assertDefaultBranch(canonicalPath: string, branch: string): Promise<void> {
    try {
      await runGit(this.config.gitBinary, ['check-ref-format', '--branch', branch], canonicalPath);
    } catch {
      throw new RepositoryContextError(
        ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
        `The project default branch is not a valid ref: ${branch}`,
      );
    }
    try {
      await runGit(
        this.config.gitBinary,
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
        canonicalPath,
      );
    } catch {
      throw new RepositoryContextError(
        ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
        `The project default branch does not exist in this repository: ${branch}`,
      );
    }
  }

  private async branchCommit(canonicalPath: string, branch: string): Promise<string> {
    try {
      const output = await runGit(
        this.config.gitBinary,
        ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
        canonicalPath,
      );
      const commit = output.trim();
      if (!commit) {
        throw new Error('empty rev-parse output');
      }
      return commit;
    } catch {
      throw new RepositoryContextError(
        ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
        `The project default branch does not resolve to a commit: ${branch}`,
      );
    }
  }
}

function runGit(binary: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorCode(error: unknown): ErrorCode | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && (ERROR_CODE_VALUES as readonly string[]).includes(code)) {
      return code as ErrorCode;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
