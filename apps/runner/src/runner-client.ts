import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import {
  RUNNER_PROTOCOL_VERSION,
  runnerServerMessageSchema,
  type RunnerCapabilities,
  type RunnerEnvelope,
  type RunnerRuntimeCapability,
  type RunnerServerMessage,
} from '@raft-lite/contracts';
import type { RunnerConfig } from './config';
import { probeRuntimeCapabilities } from './cli-probe';
import type { ExecutorCallbacks, RunnerExecutor } from './executor';
import { FakeExecutor } from './fake-executor';
import { log } from './logger';
import { RealExecutor } from './real-executor';
import { TokenStore } from './token-store';

export interface RunnerClientOptions {
  config: RunnerConfig;
  onFatal?: (message: string) => void;
}

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

  constructor(options: RunnerClientOptions) {
    this.config = options.config;
    this.onFatal = options.onFatal ?? (() => undefined);
    this.tokenStore = new TokenStore(this.config.tokenFile, this.config.runnerId);
    const callbacks: ExecutorCallbacks = {
      onPhase: (session, phase, message) => {
        this.send('execution.phase', {
          executionId: session.executionId,
          phase,
          message: message ?? null,
        });
      },
      onLog: (session, entry) => {
        this.send('execution.log', {
          executionId: session.executionId,
          entries: [entry],
        });
      },
      onProgress: (session, progress, step, progressMode) => {
        this.send('execution.progress', {
          executionId: session.executionId,
          progress,
          step,
          progressMode: progressMode ?? 'determinate',
        });
      },
      onCompleted: (session, payload) => {
        this.send('execution.completed', {
          executionId: session.executionId,
          exitCode: payload.exitCode,
          summary: payload.summary,
          git: payload.git,
        });
      },
      onFailed: (session, payload) => {
        this.send('execution.failed', {
          executionId: session.executionId,
          reason: payload.reason,
          exitCode: payload.exitCode,
          summary: payload.summary,
          git: payload.git,
        });
      },
      onCancelled: (session, payload) => {
        this.send('execution.cancelled', {
          executionId: session.executionId,
          reason: payload.reason,
          exitCode: payload.exitCode,
          git: payload.git,
        });
      },
    };
    this.executor =
      this.config.mode === 'fake'
        ? new FakeExecutor(this.config, callbacks)
        : new RealExecutor(this.config, callbacks);
  }

  async start(): Promise<void> {
    await this.prepareCapabilities();
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

  async stop(): Promise<void> {
    this.stopHeartbeat();
    this.executor.shutdown();
    await delay(150);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
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
      this.sendRegister();
      this.sendSnapshot();
      this.resendPendingLogs();
      this.startHeartbeat();
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
        break;
    }
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

    if (!this.config.projectPaths[payload.projectId]) {
      this.send('execution.failed', {
        executionId: payload.executionId,
        reason: `PROJECT_NOT_MAPPED: ${payload.projectId}`,
        exitCode: null,
        summary: null,
        git: null,
      });
      return;
    }

    if (this.config.mode === 'real') {
      const capability = this.runtimeCapabilities.find(
        (item) => item.runtime === payload.runtime,
      );
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
    const capabilities = this.capabilities();
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

  private resendPendingLogs(): void {
    for (const executionId of this.executor.activeExecutionIds()) {
      const entries = this.executor.pendingLogs(executionId);
      if (entries.length > 0) {
        this.send('execution.log', { executionId, entries: entries.slice(0, 200) });
      }
    }
  }

  private capabilities(): RunnerCapabilities {
    return {
      runtimes: this.runtimeCapabilities,
      projectIds: Object.keys(this.config.projectPaths),
      maxConcurrentExecutions: this.config.maxConcurrentExecutions,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
