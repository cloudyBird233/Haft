import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import {
  ERROR_CODES,
  RUNNER_PROTOCOL_VERSION,
  runnerServerMessageSchema,
  type ExecutionRepositoryAcceptedPayload,
  type ExecutionRepositoryPayload,
  type ExecutionRepositoryRejectedPayload,
  type ExecutionStartRejectedPayload,
  type RepositoryValidatePayload,
  type RepositoryValidationPayload,
  type RunnerCapabilities,
  type RunnerEnvelope,
  type RunnerFeature,
  type RunnerRuntimeCapability,
  type RunnerServerMessage,
} from '@raft-lite/contracts';
import type { RunnerConfig } from './config';
import { probeRuntimeCapabilities } from './cli-probe';
import type {
  ExecutorAdmission,
  ExecutorCallbacks,
  RunnerExecutor,
  ShutdownResult,
} from './executor';
import { FakeExecutor } from './fake-executor';
import { log } from './logger';
import { ProtocolEventQueue } from './protocol-event-queue';
import { RealExecutor, type RealExecutorDependencies } from './real-executor';
import { ExecutionRecovery, type RecoveredExecution } from './recovery';
import { RepositoryPolicyError, type RepositoryPathPolicy } from './repository-policy';
import {
  RepositoryContextCancelledError,
  RepositoryContextError,
  RepositoryContextManager,
  type RepositoryContext,
} from './repository-context';
import {
  RepositoryValidationCache,
  repositoryValidationPayloadHash,
} from './repository-validation-cache';
import { TokenStore } from './token-store';

export interface RunnerClientOptions {
  config: RunnerConfig;
  /**
   * The single production path authority. It is required for the validation
   * handler; tests may omit it to assert the fail-closed branch, but a real
   * runner process always injects the instance constructed in `main.ts`.
   */
  repositoryPolicy?: RepositoryPathPolicy;
  repositoryValidationCache?: RepositoryValidationCache;
  repositoryContexts?: RepositoryContextManager;
  /** Test seam for deterministic live-admission/spawn assertions. */
  realExecutorDependencies?: Partial<RealExecutorDependencies>;
  onFatal?: (message: string) => void;
}

/**
 * Features this Runner actually implements. All four repository features are
 * advertised together: handing a Runner a repository handshake without path
 * policy/validation support would be unsafe.
 */
export const RUNNER_IMPLEMENTED_FEATURES: readonly RunnerFeature[] = [
  'project-binding-v1',
  'repository-validation-v1',
  'repository-path-policy-v1',
  'repository-handshake-v1',
];

const VALIDATION_POLICY_UNCONFIGURED_VERSION = 'unconfigured';

const AUTH_ERROR_CODES = new Set([
  'RUNNER_AUTH_FAILED',
  'RUNNER_HANDSHAKE_INVALID',
  'RUNNER_NOT_FOUND',
  'COMPUTER_NOT_FOUND',
  'RUNNER_PROTOCOL_MISMATCH',
]);

export class RunnerClient {
  private readonly config: RunnerConfig;
  private readonly tokenStore: TokenStore;
  private readonly executor: RunnerExecutor;
  private readonly recovery: ExecutionRecovery;
  private readonly repositoryPolicy: RepositoryPathPolicy | null;
  private readonly repositoryContexts: RepositoryContextManager;
  private readonly validationCache: RepositoryValidationCache;
  private readonly admissions = new Map<string, Promise<void>>();
  private recoveredExecutions: RecoveredExecution[] = [];
  private readonly onFatal: (message: string) => void;
  private runtimeCapabilities: RunnerRuntimeCapability[] = [];
  private socket: Socket | null = null;
  private token: string | null = null;
  private usedBootstrap = false;
  private fatal = false;
  private connected = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = 10_000;
  private startedAt = Date.now();
  /**
   * Per-execution protocol queue. Log events await their durable spool append
   * before the socket send, and terminal events wait for every preceding log so
   * the server can never observe delivery ahead of durability.
   */
  private readonly events = new ProtocolEventQueue();
  private contextSweepTimer: NodeJS.Timeout | null = null;

  constructor(options: RunnerClientOptions) {
    this.config = options.config;
    this.onFatal = options.onFatal ?? (() => undefined);
    this.repositoryPolicy = options.repositoryPolicy ?? null;
    this.validationCache = options.repositoryValidationCache ?? new RepositoryValidationCache();
    this.repositoryContexts =
      options.repositoryContexts ??
      new RepositoryContextManager(this.config, this.repositoryPolicy);
    this.tokenStore = new TokenStore(this.config.tokenFile, this.config.runnerId);
    this.recovery = new ExecutionRecovery(this.config.recoveryRoot);
    const callbacks: ExecutorCallbacks = {
      onPhase: (session, phase, message) => {
        this.events.enqueue(session.executionId, () => {
          this.send('execution.phase', {
            executionId: session.executionId,
            phase,
            message: message ?? null,
          });
        });
      },
      onLog: (session, entry) => {
        // Await the durable append before sending: a crash between these two
        // steps leaves a spool entry that can be replayed, never a silent gap.
        this.events.enqueue(session.executionId, async () => {
          await this.recovery.appendLog(session.executionId, entry);
          this.send('execution.log', {
            executionId: session.executionId,
            entries: [entry],
          });
        });
      },
      onProgress: (session, progress, step, progressMode) => {
        this.events.enqueue(session.executionId, () => {
          this.send('execution.progress', {
            executionId: session.executionId,
            progress,
            step,
            progressMode: progressMode ?? 'determinate',
          });
        });
      },
      onCompleted: (session, payload) => {
        this.events.enqueue(session.executionId, () => {
          this.send('execution.completed', {
            executionId: session.executionId,
            exitCode: payload.exitCode,
            summary: payload.summary,
            git: payload.git,
          });
          this.repositoryContexts.release(session.executionId);
        });
      },
      onFailed: (session, payload) => {
        this.events.enqueue(session.executionId, () => {
          this.send('execution.failed', {
            executionId: session.executionId,
            reason: payload.reason,
            exitCode: payload.exitCode,
            summary: payload.summary,
            git: payload.git,
          });
          this.repositoryContexts.release(session.executionId);
        });
      },
      onCancelled: (session, payload) => {
        this.events.enqueue(session.executionId, () => {
          this.send('execution.cancelled', {
            executionId: session.executionId,
            reason: payload.reason,
            exitCode: payload.exitCode,
            git: payload.git,
          });
          this.repositoryContexts.release(session.executionId);
        });
      },
    };
    this.executor =
      this.config.mode === 'fake'
        ? new FakeExecutor(this.config, callbacks)
        : new RealExecutor(this.config, callbacks, this.recovery, {
            repositoryPolicy: this.repositoryPolicy,
            ...options.realExecutorDependencies,
          });
  }

  async start(): Promise<void> {
    await this.prepareCapabilities();
    this.contextSweepTimer = setInterval(() => this.repositoryContexts.sweep(), 60_000);
    this.contextSweepTimer.unref();
    this.recoveredExecutions = await this.recovery.scan();
    if (this.recoveredExecutions.length > 0) {
      log('warn', {
        eventType: 'runner.recovery_found',
        message: `Runner found ${this.recoveredExecutions.length} interrupted execution(s) from a previous process`,
        status: 'degraded',
      });
    }
    this.token = await this.tokenStore.read();
    if (!this.token && !this.config.bootstrapToken) {
      throw new Error(
        'No cached runner token or bootstrap token. Set HAFT_RUNNER_BOOTSTRAP_TOKEN to pair this runner.',
      );
    }
    this.connect();
  }

  mode(): RunnerConfig['mode'] {
    return this.config.mode;
  }

  isConnected(): boolean {
    return this.connected;
  }

  activeExecutionIds(): string[] {
    return this.executor.activeExecutionIds();
  }

  pendingLogCount(): number {
    return this.executor.pendingLogCount();
  }

  async stop(): Promise<ShutdownResult> {
    this.stopHeartbeat();
    if (this.contextSweepTimer) {
      clearInterval(this.contextSweepTimer);
      this.contextSweepTimer = null;
    }
    // Keep the socket connected while sessions finalize so their terminal
    // events reach the server. Never assume a fixed delay equals termination.
    const result = await this.executor.shutdown('Runner shutting down');
    if (!result.clean) {
      log('error', {
        eventType: 'runner.shutdown_incomplete',
        message: 'Runner could not confirm that every CLI process stopped',
        status: 'error',
        remainingExecutionIds: result.remainingExecutionIds,
        forced: result.forced,
      });
    } else {
      log('info', {
        eventType: 'runner.shutdown_complete',
        message: 'All runner sessions reached a terminal state',
        status: 'offline',
        forced: result.forced,
      });
    }
    // Log appends and the terminal event travel through the per-execution
    // queue. Drain it so the last log is durable and delivered before the
    // socket closes.
    await this.events.drain();
    await this.recovery.spool.flush();
    await this.recovery.journal.flushAll();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    return result;
  }

  private connect(): void {
    const socket = io(`${this.config.serverUrl}/runner`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
      autoConnect: true,
      auth: (callback: (data: Record<string, unknown>) => void) => {
        callback(this.handshakeAuth());
      },
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.connected = true;
      this.startedAt = Date.now();
      log('info', {
        eventType: 'runner.connected',
        message: 'Connected to the Haft API',
        status: 'online',
      });
      void this.onConnected();
    });

    socket.on('disconnect', (reason) => {
      this.connected = false;
      this.stopHeartbeat();
      log('warn', {
        eventType: 'runner.disconnected',
        message: 'Disconnected from the Haft API; active executions stay in memory',
        status: 'offline',
        error: reason,
      });
      if (reason === 'io server disconnect' && !this.fatal) {
        this.retryWithBootstrap();
      }
    });

    socket.on('connect_error', (error: Error) => {
      const data = (error as Error & { data?: { code?: string } }).data;
      const code = data?.code ?? error.message.split(':')[0] ?? 'CONNECT_ERROR';
      if (AUTH_ERROR_CODES.has(code) && this.retryWithBootstrap()) {
        return;
      }
      log('warn', {
        eventType: 'runner.connect_error',
        message: 'Could not connect to the Haft API; retrying',
        status: 'offline',
        error: error.message,
      });
      if (AUTH_ERROR_CODES.has(code)) {
        this.fatal = true;
        this.socket?.disconnect();
        this.onFatal(error.message);
      }
    });

    socket.on('runner.message', (raw: unknown) => {
      this.handleMessage(raw);
    });
  }

  private handleMessage(raw: unknown): void {
    const parsed = runnerServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log('warn', {
        eventType: 'runner.message_invalid',
        message: 'Server message does not match runner protocol v1',
        error: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
      return;
    }
    const message = parsed.data;
    if (message.runnerId !== this.config.runnerId && message.type !== 'runner.error') {
      return;
    }

    switch (message.type) {
      case 'runner.welcome':
        this.handleWelcome(message.payload);
        break;
      case 'runner.error':
        this.handleServerError(message.payload);
        break;
      case 'execution.start':
        void this.handleStart(message.payload).catch((error: unknown) => {
          log('error', {
            eventType: 'runner.admission_failed',
            message: 'Execution admission ended with an unexpected error',
            executionId: message.payload.executionId,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        });
        break;
      case 'execution.repository':
        void this.handleRepository(message.payload).catch((error: unknown) => {
          log('error', {
            eventType: 'runner.repository_handler_failed',
            message: 'Repository handshake handler ended with an unexpected error',
            executionId: message.payload.executionId,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        });
        break;
      case 'execution.cancel':
        this.handleCancel(message.payload.executionId, message.payload.reason);
        break;
      case 'execution.reconcile':
        log('info', {
          eventType: 'runner.reconcile',
          message: 'Server asked the runner to reconcile execution state',
          status: 'online',
        });
        this.sendSnapshot();
        break;
      case 'execution.log.ack':
        this.executor.acknowledge(message.payload.executionId, message.payload.throughSeq);
        void this.recovery.acknowledgeLogs(message.payload.executionId, message.payload.throughSeq);
        break;
      case 'repository.validate':
        void this.handleRepositoryValidate(message.payload);
        break;
    }
  }

  /**
   * Path-only repository validation. The handler never throws into the socket
   * message path: every failure becomes a `repository.validation` with a
   * concrete code so the API can persist an honest result.
   */
  private async handleRepositoryValidate(payload: RepositoryValidatePayload): Promise<void> {
    const payloadHash = repositoryValidationPayloadHash(payload);
    try {
      if (!this.repositoryPolicy) {
        this.sendValidationFailure(
          payload,
          ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED,
          'The runner has no repository path policy',
          VALIDATION_POLICY_UNCONFIGURED_VERSION,
        );
        return;
      }
      const policyVersion = this.repositoryPolicy.policyVersion;
      if (payload.computerId !== this.config.computerId) {
        this.sendValidationFailure(
          payload,
          ERROR_CODES.REPO_VALIDATION_FAILED,
          'Validation request targets a different computer',
          policyVersion,
        );
        return;
      }

      const cached = this.validationCache.get(payload.requestId, payloadHash);
      if (cached.status === 'conflict') {
        this.sendValidationFailure(
          payload,
          ERROR_CODES.REPO_VALIDATION_FAILED,
          'requestId was already used with a different validation payload',
          policyVersion,
        );
        return;
      }
      if (cached.status === 'hit') {
        // A replay always gets a fresh envelope ID. The cached payload must be
        // returned byte-for-byte so the API observes the same facts.
        this.send('repository.validation', cached.payload);
        return;
      }

      // Do not pre-check `policy.configError`: `validate()` rejects Windows
      // device paths before configuration (plan §9.4 precedence) and otherwise
      // returns REPOSITORY_POLICY_NOT_CONFIGURED for an unusable policy.
      const result = await this.repositoryPolicy.validate(payload.path);
      const response = this.toValidationPayload(payload, result);
      this.validationCache.set(payload.requestId, payloadHash, response);
      this.send('repository.validation', response);
    } catch (error) {
      const policyVersion =
        this.repositoryPolicy?.policyVersion ?? VALIDATION_POLICY_UNCONFIGURED_VERSION;
      const response: RepositoryValidationPayload = {
        requestId: payload.requestId,
        projectId: payload.projectId,
        computerId: payload.computerId,
        bindingId: payload.bindingId,
        bindingVersion: payload.bindingVersion,
        ok: false,
        platform: this.config.platform,
        policyVersion,
        errorCode: ERROR_CODES.REPO_VALIDATION_FAILED,
        message: `Repository validation failed: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 2000),
      };
      this.validationCache.set(payload.requestId, payloadHash, response);
      this.send('repository.validation', response);
    }
  }

  private toValidationPayload(
    request: RepositoryValidatePayload,
    result: Awaited<ReturnType<RepositoryPathPolicy['validate']>>,
  ): RepositoryValidationPayload {
    const base = {
      requestId: request.requestId,
      projectId: request.projectId,
      computerId: request.computerId,
      bindingId: request.bindingId,
      bindingVersion: request.bindingVersion,
      platform: result.platform,
      policyVersion: result.policyVersion,
    };
    if (result.ok) {
      if (!result.canonicalPath || !result.headCommit) {
        return {
          ...base,
          ok: false,
          errorCode: ERROR_CODES.REPO_VALIDATION_FAILED,
          message: 'Repository validation succeeded without canonicalPath/headCommit',
        };
      }
      return {
        ...base,
        ok: true,
        canonicalPath: result.canonicalPath,
        headCommit: result.headCommit,
      };
    }
    return {
      ...base,
      ok: false,
      errorCode: result.errorCode ?? ERROR_CODES.REPO_VALIDATION_FAILED,
      message: result.message ?? 'Repository validation failed',
    };
  }

  private sendValidationFailure(
    request: RepositoryValidatePayload,
    errorCode: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    message: string,
    policyVersion: string,
  ): void {
    this.send('repository.validation', {
      requestId: request.requestId,
      projectId: request.projectId,
      computerId: request.computerId,
      bindingId: request.bindingId,
      bindingVersion: request.bindingVersion,
      ok: false,
      platform: this.config.platform,
      policyVersion,
      errorCode,
      message,
    } satisfies RepositoryValidationPayload);
  }

  private async handleWelcome(
    payload: Extract<RunnerServerMessage, { type: 'runner.welcome' }>['payload'],
  ): Promise<void> {
    this.heartbeatIntervalMs = payload.heartbeatIntervalMs;
    this.startHeartbeat();
    if (payload.issuedToken) {
      this.token = payload.issuedToken;
      await this.tokenStore.write(payload.issuedToken);
      log('info', {
        eventType: 'runner.paired',
        message: 'Runner token issued and stored locally',
        status: 'online',
      });
    }
  }

  private handleServerError(
    payload: Extract<RunnerServerMessage, { type: 'runner.error' }>['payload'],
  ): void {
    log(payload.fatal ? 'error' : 'warn', {
      eventType: 'runner.server_error',
      message: payload.message,
      status: 'error',
      error: payload.code,
    });
    if (!payload.fatal) {
      return;
    }
    if (AUTH_ERROR_CODES.has(payload.code) && this.retryWithBootstrap()) {
      return;
    }
    this.fatal = true;
    this.socket?.disconnect();
    this.onFatal(`${payload.code}: ${payload.message}`);
  }

  /**
   * Cancellation is recorded synchronously before any asynchronous cleanup.
   * If no executor session exists, this method itself confirms the pre-start
   * cancellation to the API; an active session keeps the existing terminate
   * and terminal-event path.
   */
  private handleCancel(executionId: string, reason?: string | null): void {
    const resolved = reason?.trim() || 'Cancelled by operator';
    const hadSession = this.executor.hasActiveSession(executionId);
    const first = this.repositoryContexts.cancel(executionId, resolved);
    // Always let the executor drop any admission-only state (for example a
    // resolved executable cached before start). With an active session this
    // also starts the existing process-termination path.
    this.executor.cancel(executionId, resolved);
    if (hadSession) return;
    if (!first) return;
    this.send('execution.cancelled', {
      executionId,
      reason: resolved,
      exitCode: null,
      git: null,
    });
    log('info', {
      eventType: 'runner.execution_cancelled_before_start',
      message: 'Confirmed a pre-start cancellation without an active executor session',
      executionId,
      status: 'cancelled',
    });
  }

  private async handleStart(
    payload: Extract<RunnerServerMessage, { type: 'execution.start' }>['payload'],
  ): Promise<void> {
    const inFlight = this.admissions.get(payload.executionId);
    if (inFlight) {
      // A duplicate start waits for the first admission instead of spawning a
      // second process. The first handler already sent the single accepted.
      await inFlight;
      return;
    }
    const admission = this.runAdmission(payload);
    this.admissions.set(payload.executionId, admission);
    try {
      await admission;
    } finally {
      if (this.admissions.get(payload.executionId) === admission) {
        this.admissions.delete(payload.executionId);
      }
    }
  }

  private async runAdmission(
    payload: Extract<RunnerServerMessage, { type: 'execution.start' }>['payload'],
  ): Promise<void> {
    const executionId = payload.executionId;
    let acceptedSent = false;
    try {
      if (this.repositoryContexts.isCancelled(executionId)) {
        // Cancellation already owns the terminal path. Still answer a late
        // start deterministically so an old API process cannot mistake the
        // silence for an admission in progress.
        this.sendStartRejected(
          executionId,
          ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
          'The execution was cancelled before admission',
        );
        return;
      }

      log('info', {
        eventType: 'runner.execution_received',
        message: `Dispatching ${payload.runtime} execution`,
        executionId,
        status: 'running',
      });

      const state = this.repositoryContexts.beginStart(executionId);
      if (state === 'missing') {
        this.sendStartRejected(
          executionId,
          ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
          'No ready repository context exists for this execution',
        );
        return;
      }
      if (state === 'started') {
        // Duplicate start after the spawn: re-send accepted, never respawn.
        this.send('execution.accepted', {
          executionId,
          acceptedAt: new Date().toISOString(),
        });
        return;
      }
      if (state === 'starting') {
        const inFlight = this.admissions.get(executionId);
        if (inFlight) {
          await inFlight;
          return;
        }
      }

      const context = this.repositoryContexts.get(executionId);
      if (!context) {
        this.sendStartRejected(
          executionId,
          ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
          'The repository context disappeared during admission',
        );
        return;
      }

      const failure = await this.admissionFailure(payload, context);
      if (failure) {
        this.repositoryContexts.release(executionId);
        this.sendStartRejected(executionId, failure.code, failure.message, failure.retryable);
        return;
      }

      // Admission performed real awaits (live CLI probe, capacity, policy).
      // A cancel may have arrived in that window; never turn it into a spawn.
      if (this.repositoryContexts.isCancelled(executionId)) {
        this.repositoryContexts.release(executionId);
        return;
      }
      const current = this.repositoryContexts.get(executionId);
      if (!current || current.contextId !== context.contextId) {
        this.repositoryContexts.release(executionId);
        this.sendStartRejected(
          executionId,
          ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
          'The repository context expired during admission',
        );
        return;
      }

      this.repositoryContexts.markStarted(executionId);
      // The Runner must never spawn before the API has this acknowledgement.
      this.send('execution.accepted', {
        executionId,
        acceptedAt: new Date().toISOString(),
      });
      acceptedSent = true;
      try {
        this.executor.start(payload, context);
      } catch (error) {
        // `executor.start` runs after accepted by contract; a synchronous
        // throw here cannot be converted into a pre-start rejection.
        log('error', {
          eventType: 'runner.executor_start_failed',
          message: 'Executor threw synchronously after execution.accepted',
          executionId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      if (acceptedSent || this.repositoryContexts.isCancelled(executionId)) {
        return;
      }
      this.repositoryContexts.release(executionId);
      this.sendStartRejected(
        executionId,
        errorCode(error) ?? ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
        errorMessage(error),
      );
    }
  }

  private async admissionFailure(
    payload: Extract<RunnerServerMessage, { type: 'execution.start' }>['payload'],
    context: RepositoryContext,
  ): Promise<Extract<ExecutorAdmission, { ok: false }> | null> {
    if (!this.repositoryPolicy) {
      return {
        ok: false,
        code: ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED,
        message: 'The runner has no repository path policy',
        retryable: false,
      };
    }
    if (context.policyVersion !== this.repositoryPolicy.policyVersion) {
      return {
        ok: false,
        code: ERROR_CODES.REPOSITORY_POLICY_CHANGED,
        message: 'The runner path policy changed after the repository handshake',
        retryable: false,
      };
    }
    try {
      await this.repositoryPolicy.assertStillAllowed(context.canonicalPath);
    } catch (error) {
      return {
        ok: false,
        code:
          error instanceof RepositoryPolicyError
            ? error.code
            : ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }

    // The executor owns the live admission checks (runtime enabled, capacity,
    // duplicate, CLI resolution and authentication at this instant). The
    // startup capability cache is registration metadata only and is never
    // treated as final admission evidence.
    const admitted = await this.executor.canAdmit(payload, context);
    if (!admitted.ok) {
      return admitted;
    }
    return null;
  }

  private sendStartRejected(
    executionId: string,
    code: ExecutionStartRejectedPayload['code'],
    message: string,
    retryable = false,
  ): void {
    this.send('execution.start.rejected', {
      executionId,
      code,
      message: message.slice(0, 2000),
      retryable,
    } satisfies ExecutionStartRejectedPayload);
  }

  /**
   * Creates or reuses the in-memory repository context. It is the only
   * handshake stage that checks Project.defaultBranch existence and it never
   * spawns a CLI.
   */
  private async handleRepository(payload: ExecutionRepositoryPayload): Promise<void> {
    try {
      if (!this.repositoryPolicy) {
        throw new RepositoryContextError(
          ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED,
          'The runner has no repository path policy',
        );
      }
      if (payload.policyVersion !== this.repositoryPolicy.policyVersion) {
        throw new RepositoryContextError(
          ERROR_CODES.REPOSITORY_POLICY_CHANGED,
          'The binding was validated under a different path policy; revalidate it',
        );
      }
      const context = await this.repositoryContexts.prepare(payload);
      const accepted: ExecutionRepositoryAcceptedPayload = {
        executionId: payload.executionId,
        projectId: payload.projectId,
        bindingId: payload.bindingId,
        bindingVersion: payload.bindingVersion,
        policyVersion: context.policyVersion,
        contextId: context.contextId,
        canonicalPath: context.canonicalPath,
        defaultBranch: context.defaultBranch,
        baseCommit: context.baseCommit,
        acceptedAt: new Date().toISOString(),
      };
      this.send('execution.repository.accepted', accepted);
    } catch (error) {
      if (error instanceof RepositoryContextCancelledError) {
        // The cancel handler already confirmed `execution.cancelled`; a late
        // repository rejection would race the terminal state for no benefit.
        return;
      }
      const code =
        error instanceof RepositoryContextError
          ? error.code
          : ERROR_CODES.REPOSITORY_CONTEXT_REJECTED;
      // Keep an existing context on a conflicting duplicate: the API may retry
      // the original payload and must receive the same contextId.
      if (code !== ERROR_CODES.REPOSITORY_CONTEXT_CONFLICT) {
        this.repositoryContexts.release(payload.executionId);
      }
      const rejected: ExecutionRepositoryRejectedPayload = {
        executionId: payload.executionId,
        projectId: payload.projectId,
        bindingId: payload.bindingId,
        bindingVersion: payload.bindingVersion,
        code,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        retryable: code === ERROR_CODES.REPOSITORY_CONTEXT_REJECTED,
      };
      this.send('execution.repository.rejected', rejected);
    }
  }

  private async prepareCapabilities(): Promise<void> {
    if (this.config.mode === 'fake') {
      this.runtimeCapabilities = this.config.fakeRuntimes.map((runtime) => ({
        runtime,
        installed: true,
        version: 'fake-1.0.0',
        authenticated: true,
        message: 'Simulated by the Haft Fake Runner; no real model is invoked.',
      }));
      return;
    }

    this.runtimeCapabilities = await probeRuntimeCapabilities(this.config);
    for (const capability of this.runtimeCapabilities) {
      log(capability.installed && capability.authenticated ? 'info' : 'warn', {
        eventType: 'runner.runtime_probe',
        message: `${capability.runtime} capability probe completed`,
        status: capability.installed
          ? capability.authenticated
            ? 'ready'
            : 'unauthenticated'
          : 'missing',
        runtime: capability.runtime,
        version: capability.version,
        installed: capability.installed,
        authenticated: capability.authenticated,
        detail: capability.message,
      });
    }
  }

  private sendRegister(): void {
    const capabilities = this.advertisedCapabilities();
    this.send('runner.register', {
      computerId: this.config.computerId,
      runnerVersion: this.config.runnerVersion,
      platform: this.config.platform,
      architecture: this.config.architecture,
      capabilities,
    });
  }

  private sendSnapshot(): void {
    this.send('runner.snapshot', {
      executions: this.executor.snapshot(),
      pendingLogCount: this.executor.pendingLogCount(),
    });
  }

  private async onConnected(): Promise<void> {
    this.sendRegister();
    await this.sendRecoveryReports();
    this.sendSnapshot();
    await this.resendPendingLogs();
    this.startHeartbeat();
  }

  /**
   * Reports executions found in the recovery journal before the snapshot is
   * sent. The snapshot then contains only genuinely live in-memory sessions, so
   * the server does not misinterpret a recovered execution as still running.
   */
  private async sendRecoveryReports(): Promise<void> {
    if (this.recoveredExecutions.length === 0) return;
    const pending: RecoveredExecution[] = [];
    for (let index = 0; index < this.recoveredExecutions.length; index += 1) {
      const report = this.recoveredExecutions[index] as RecoveredExecution;
      const entries =
        report.logs.length > 0
          ? report.logs
          : await this.recovery.readLogs(report.record.executionId, 200);
      let delivered = true;
      if (entries.length > 0) {
        delivered = this.send('execution.log', {
          executionId: report.record.executionId,
          entries: entries.slice(-200),
        });
      }
      if (delivered) {
        delivered = this.send('execution.failed', {
          executionId: report.record.executionId,
          reason: report.summary.slice(0, 2000),
          exitCode: null,
          summary: report.summary,
          git: null,
        });
      }
      if (!delivered) {
        pending.push(...this.recoveredExecutions.slice(index));
        break;
      }
      log('warn', {
        eventType: 'runner.recovery_reported',
        message: report.summary,
        status: 'interrupted',
        executionId: report.record.executionId,
        orphanTerminated: report.orphanTerminated,
        orphanStillAlive: report.orphanStillAlive,
      });
    }
    this.recoveredExecutions = pending;
  }

  private async resendPendingLogs(): Promise<void> {
    for (const executionId of this.executor.activeExecutionIds()) {
      const pending = this.executor.pendingLogs(executionId);
      const spooled = await this.recovery.readLogs(executionId);
      const bySequence = new Map<number, (typeof pending)[number]>();
      for (const entry of [...spooled, ...pending]) {
        bySequence.set(entry.sequence, entry);
      }
      const entries = [...bySequence.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-200);
      if (entries.length > 0) {
        this.send('execution.log', { executionId, entries });
      }
    }
  }

  /**
   * Register payload capabilities. `projectIds` is intentionally always empty:
   * repository selection is server-supplied via a binding, never a local
   * project map. All four repository features are advertised together.
   */
  advertisedCapabilities(): RunnerCapabilities {
    return {
      runtimes: this.runtimeCapabilities,
      projectIds: [],
      maxConcurrentExecutions: this.config.maxConcurrentExecutions,
      features: [...RUNNER_IMPLEMENTED_FEATURES],
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const tick = (): void => {
      const active = this.executor.activeExecutionIds();
      this.send('runner.heartbeat', {
        activeExecutionIds: active,
        status: active.length > 0 ? 'busy' : 'online',
        uptimeMs: Date.now() - this.startedAt,
      });
    };
    tick();
    this.heartbeatTimer = setInterval(tick, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private retryWithBootstrap(): boolean {
    if (!this.config.bootstrapToken || this.usedBootstrap || this.fatal) {
      return false;
    }
    this.usedBootstrap = true;
    this.token = null;
    void this.tokenStore.clear();
    log('info', {
      eventType: 'runner.repairing',
      message: 'Cached token was rejected; pairing again with the bootstrap token',
      status: 'offline',
    });
    const socket = this.socket;
    setTimeout(() => {
      if (socket && !socket.connected) {
        socket.connect();
      }
    }, 250);
    return true;
  }

  private handshakeAuth(): Record<string, unknown> {
    return {
      runnerId: this.config.runnerId,
      computerId: this.config.computerId,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      ...(this.token
        ? { token: this.token }
        : this.config.bootstrapToken
          ? { bootstrapToken: this.config.bootstrapToken }
          : {}),
    };
  }

  private send(type: string, payload: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket) return false;
    const envelope: RunnerEnvelope = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      messageId: randomUUID(),
      runnerId: this.config.runnerId,
      type,
      sentAt: new Date().toISOString(),
      payload,
    };
    socket.emit('runner.message', envelope);
    return socket.connected;
  }
}

function errorCode(error: unknown): ExecutionStartRejectedPayload['code'] | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code as ExecutionStartRejectedPayload['code'];
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}
