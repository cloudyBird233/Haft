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

/**
 * Internal cancellation outcome. It is never forwarded as a repository
 * rejection: the API already owns the cancel terminal state, and a late
 * rejection after `execution.cancelled` would only create noise.
 */
export class RepositoryContextCancelledError extends RepositoryContextError {
  readonly cancelled = true;

  constructor(message = 'The repository context preparation was cancelled') {
    super(ERROR_CODES.REPOSITORY_CONTEXT_REJECTED, message);
    this.name = 'RepositoryContextCancelledError';
  }
}

interface InflightPrepare {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<RepositoryContext>;
}

const PRE_START_TTL_MS = 10 * 60_000;
const STARTING_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * In-memory repository context lifecycle for the execution handshake.
 *
 * `prepare` is the only P2-02 stage that checks `Project.defaultBranch`
 * existence. It never spawns a CLI and never touches the main checkout.
 * Contexts do not survive a runner process restart; the API must resend
 * `execution.repository`.
 *
 * Concurrency: an in-flight preparation is shared by every duplicate message
 * with the same execution id and fingerprint. A cancel records a durable
 * in-memory intent and aborts the shared operation, so a late completion can
 * never re-insert a context after `release`/`cancel`.
 */
export class RepositoryContextManager {
  private readonly contexts = new Map<string, RepositoryContext>();
  private readonly inflight = new Map<string, InflightPrepare>();
  private readonly cancelled = new Map<string, string>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly config: Pick<
      RunnerConfig,
      'gitBinary' | 'worktreeRoot' | 'recoveryRoot' | 'platform'
    >,
    private readonly policy: RepositoryPathPolicy | null,
  ) {}

  async prepare(payload: ExecutionRepositoryPayload): Promise<RepositoryContext> {
    const cancelReason = this.cancelled.get(payload.executionId);
    if (cancelReason !== undefined) {
      throw new RepositoryContextCancelledError(cancelReason);
    }

    const existing = this.contexts.get(payload.executionId);
    if (existing) {
      if (this.matches(existing, payload)) {
        existing.lastUsedAt = Date.now();
        return { ...existing };
      }
      throw new RepositoryContextError(
        ERROR_CODES.REPOSITORY_CONTEXT_CONFLICT,
        'The execution id is already bound to a different repository context',
      );
    }

    const fingerprint = this.fingerprint(payload);
    const inFlight = this.inflight.get(payload.executionId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw new RepositoryContextError(
          ERROR_CODES.REPOSITORY_CONTEXT_CONFLICT,
          'The execution id is already being prepared with a different repository context',
        );
      }
      // Same execution id and same request: share one git/policy run and one
      // contextId. Every caller observes the same resolve/reject outcome.
      return inFlight.promise;
    }

    const generation = this.generation(payload.executionId);
    const controller = new AbortController();
    const promise = this.doPrepare(payload, generation, controller.signal).finally(() => {
      const current = this.inflight.get(payload.executionId);
      if (current?.promise === promise) {
        this.inflight.delete(payload.executionId);
      }
    });
    // The map may hold a rejected promise while another duplicate is still
    // about to await it; never let that become an unhandled rejection.
    promise.catch(() => undefined);
    this.inflight.set(payload.executionId, { fingerprint, controller, promise });
    return promise;
  }

  beginStart(executionId: string): 'acquired' | 'starting' | 'started' | 'missing' {
    if (this.cancelled.has(executionId)) return 'missing';
    const context = this.contexts.get(executionId);
    if (!context) return 'missing';
    context.lastUsedAt = Date.now();
    if (context.state === 'started') return 'started';
    if (context.state === 'starting') return 'starting';
    context.state = 'starting';
    return 'acquired';
  }

  markStarted(executionId: string): void {
    if (this.cancelled.has(executionId)) {
      this.contexts.delete(executionId);
      return;
    }
    const context = this.contexts.get(executionId);
    if (!context) return;
    context.state = 'started';
    context.lastUsedAt = Date.now();
  }

  /**
   * Invalidates any current context and in-flight preparation. A later
   * repository retry is allowed (admission failure handling relies on that).
   */
  release(executionId: string): void {
    this.bumpGeneration(executionId);
    const inFlight = this.inflight.get(executionId);
    if (inFlight) {
      this.inflight.delete(executionId);
      inFlight.controller.abort();
    }
    this.contexts.delete(executionId);
  }

  /**
   * Records the operator cancel intent before any asynchronous cleanup.
   * Returns true only for the first cancel of this execution.
   */
  cancel(executionId: string, reason = 'Cancelled by operator'): boolean {
    const first = !this.cancelled.has(executionId);
    this.cancelled.set(executionId, reason);
    this.bumpGeneration(executionId);
    const inFlight = this.inflight.get(executionId);
    if (inFlight) {
      this.inflight.delete(executionId);
      inFlight.controller.abort();
    }
    this.contexts.delete(executionId);
    return first;
  }

  isCancelled(executionId: string): boolean {
    return this.cancelled.has(executionId);
  }

  get(executionId: string): RepositoryContext | null {
    const context = this.contexts.get(executionId);
    return context ? { ...context } : null;
  }

  /** Sweeps unused `ready` contexts; `starting` has a short fallback TTL. */
  sweep(now: number = Date.now()): void {
    for (const [executionId, context] of this.contexts) {
      if (context.state === 'started') continue;
      const ttl = context.state === 'ready' ? PRE_START_TTL_MS : STARTING_TTL_MS;
      if (now - context.lastUsedAt >= ttl) {
        this.release(executionId);
      }
    }
  }

  private async doPrepare(
    payload: ExecutionRepositoryPayload,
    generation: number,
    signal: AbortSignal,
  ): Promise<RepositoryContext> {
    this.throwIfInvalidated(payload.executionId, generation, signal);
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

    let validation: Awaited<ReturnType<RepositoryPathPolicy['validate']>>;
    try {
      validation = await this.policy.validate(payload.path);
    } catch (error) {
      this.throwIfInvalidated(payload.executionId, generation, signal);
      throw error;
    }
    this.throwIfInvalidated(payload.executionId, generation, signal);
    if (!validation.ok || !validation.canonicalPath || !validation.headCommit) {
      throw new RepositoryContextError(
        validation.errorCode ?? ERROR_CODES.REPOSITORY_CONTEXT_REJECTED,
        validation.message ?? 'Repository path validation failed',
      );
    }

    await this.assertDefaultBranch(
      validation.canonicalPath,
      payload.defaultBranch,
      payload.executionId,
      generation,
      signal,
    );
    // Re-run isolation immediately before storing the context (TOCTOU).
    try {
      await this.policy.assertStillAllowed(validation.canonicalPath);
    } catch (error) {
      this.throwIfInvalidated(payload.executionId, generation, signal);
      throw new RepositoryContextError(
        errorCode(error) ?? ERROR_CODES.REPOSITORY_CONTEXT_REJECTED,
        errorMessage(error),
      );
    }
    this.throwIfInvalidated(payload.executionId, generation, signal);

    const baseCommit = await this.branchCommit(
      validation.canonicalPath,
      payload.defaultBranch,
      payload.executionId,
      generation,
      signal,
    );
    // No await between the final check and the insert: a cancel/release cannot
    // interleave here, and every earlier await was followed by a check.
    this.throwIfInvalidated(payload.executionId, generation, signal);

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
    return { ...context };
  }

  private throwIfInvalidated(executionId: string, generation: number, signal: AbortSignal): void {
    const reason = this.cancelled.get(executionId);
    if (reason !== undefined) {
      throw new RepositoryContextCancelledError(reason);
    }
    if (signal.aborted || this.generation(executionId) !== generation) {
      throw new RepositoryContextError(
        ERROR_CODES.REPOSITORY_CONTEXT_REJECTED,
        'The repository context preparation was invalidated',
      );
    }
  }

  private generation(executionId: string): number {
    return this.generations.get(executionId) ?? 0;
  }

  private bumpGeneration(executionId: string): void {
    this.generations.set(executionId, this.generation(executionId) + 1);
  }

  private fingerprint(payload: ExecutionRepositoryPayload): string {
    return JSON.stringify([
      payload.projectId,
      payload.bindingId,
      payload.bindingVersion,
      payload.policyVersion,
      payload.defaultBranch,
      comparable(payload.path, this.config.platform),
    ]);
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
  private async assertDefaultBranch(
    canonicalPath: string,
    branch: string,
    executionId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await runGit(
        this.config.gitBinary,
        ['check-ref-format', '--branch', branch],
        canonicalPath,
        signal,
      );
    } catch {
      this.throwIfInvalidated(executionId, generation, signal);
      throw new RepositoryContextError(
        ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
        `The project default branch is not a valid ref: ${branch}`,
      );
    }
    this.throwIfInvalidated(executionId, generation, signal);
    try {
      await runGit(
        this.config.gitBinary,
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
        canonicalPath,
        signal,
      );
    } catch {
      this.throwIfInvalidated(executionId, generation, signal);
      throw new RepositoryContextError(
        ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
        `The project default branch does not exist in this repository: ${branch}`,
      );
    }
    this.throwIfInvalidated(executionId, generation, signal);
  }

  private async branchCommit(
    canonicalPath: string,
    branch: string,
    executionId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const output = await runGit(
        this.config.gitBinary,
        ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
        canonicalPath,
        signal,
      );
      const commit = output.trim();
      if (!commit) {
        throw new Error('empty rev-parse output');
      }
      return commit;
    } catch {
      this.throwIfInvalidated(executionId, generation, signal);
      throw new RepositoryContextError(
        ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
        `The project default branch does not resolve to a commit: ${branch}`,
      );
    }
  }
}

function runGit(
  binary: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
        signal,
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
