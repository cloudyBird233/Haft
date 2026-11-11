import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import {
  ERROR_CODES,
  RUNNER_PROTOCOL_VERSION,
  runnerServerMessageSchema,
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
import type { ExecutorCallbacks, RunnerExecutor, ShutdownResult } from './executor';
import { FakeExecutor } from './fake-executor';
import { log } from './logger';
import { ProtocolEventQueue } from './protocol-event-queue';
import { RealExecutor } from './real-executor';
import { ExecutionRecovery, type RecoveredExecution } from './recovery';
import type { RepositoryPathPolicy } from './repository-policy';
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
  onFatal?: (message: string) => void;
}

/**
 * Features this Runner actually implements at the WP-A boundary. Do not add
 * project-binding-v1 or repository-handshake-v1 here until WP-C implements the
 * corresponding messages.
 */
export const RUNNER_IMPLEMENTED_FEATURES: readonly RunnerFeature[] = [
  'repository-validation-v1',
  'repository-path-policy-v1',
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
  private readonly validationCache: RepositoryValidationCache;
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

  constructor(options: RunnerClientOptions) {
    this.config = options.config;
    this.onFatal = options.onFatal ?? (() => undefined);
    this.repositoryPolicy = options.repositoryPolicy ?? null;
    this.validationCache = options.repositoryValidationCache ?? new RepositoryValidationCache();
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
        });
      },
    };
    this.executor =
      this.config.mode === 'fake'
        ? new FakeExecutor(this.config, callbacks)
        : new RealExecutor(this.config, callbacks, this.recovery);
  }

  async start(): Promise<void> {
    await this.prepareCapabilities();
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
        this.handleStart(message.payload);
        break;
      case 'execution.cancel':
        this.executor.cancel(message.payload.executionId, message.payload.reason);
        break;
      case 'execution.reconcile':
        log('info', {
          eventType: 'runner.reconcile',
          message: 'Server asked the runner to reconcile execution state',
          status: 'online',
        });
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

  private handleStart(
    payload: Extract<RunnerServerMessage, { type: 'execution.start' }>['payload'],
  ): void {
    log('info', {
      eventType: 'runner.execution_received',
      message: `Dispatching ${payload.runtime} execution`,
      executionId: payload.executionId,
      status: 'running',
    });
    this.send('execution.accepted', {
      executionId: payload.executionId,
      acceptedAt: new Date().toISOString(),
    });

    if (this.config.mode === 'real') {
      const capability = this.runtimeCapabilities.find((item) => item.runtime === payload.runtime);
      if (!capability?.installed) {
        this.send('execution.failed', {
          executionId: payload.executionId,
          reason:
            capability?.message ??
            `CLI_NOT_INSTALLED: ${payload.runtime} is not available on this runner`,
          exitCode: null,
          summary: null,
          git: null,
        });
        return;
      }
      if (!capability.authenticated) {
        this.send('execution.failed', {
          executionId: payload.executionId,
          reason:
            capability.message ??
            `CLI_NOT_AUTHENTICATED: ${payload.runtime} is not authenticated on this runner`,
          exitCode: null,
          summary: null,
          git: null,
        });
        return;
      }
    }

    this.executor.start(payload);
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
   * repository selection is now server-supplied via a binding, never a local
   * project map. Only the two implemented WP-A features are advertised.
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
