import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type {
  ExecutionRepositoryAcceptedPayload,
  ExecutionRepositoryPayload,
  ExecutionRepositoryRejectedPayload,
  ExecutionStartRejectedPayload,
  RepositoryValidatePayload,
  RepositoryValidationPayload,
  RunnerCapabilities,
  RunnerEnvelope,
  RunnerFeature,
  RunnerInboundMessage,
  RunnerStatus,
} from '@raft-lite/contracts';
import { RUNNER_PROTOCOL_VERSION } from '@raft-lite/contracts';
import { AppException } from '../../common/errors/app.exception';
import { AppLogger } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toRunnerDto } from '../../common/serializers';
import type { RuntimeEvent } from '../runtime/agent-runtime.interface';

export interface RunnerTransport {
  send(runnerId: string, message: RunnerEnvelope): boolean;
  isConnected(runnerId: string): boolean;
}

export interface RunnerHandshakeInput {
  runnerId: string;
  computerId: string;
  protocolVersion?: number;
  token?: string;
  bootstrapToken?: string;
}

export interface RunnerHandshakeResult {
  runnerId: string;
  computerId: string;
  issuedToken: string | null;
  protocolVersion: number;
}

export type ExecutionAcceptedPayload = Extract<
  RunnerInboundMessage,
  { type: 'execution.accepted' }
>['payload'];

export interface RunnerConnectionInfo {
  runnerId: string;
  computerId: string;
  socketId: string;
  connectedAt: Date;
}

/**
 * The live registration facts reported by the authenticated socket. These are
 * deliberately not read from `capabilitiesJson`: a reconnect or upgrade must be
 * able to change features/platform without waiting for a database reader to
 * observe a stale historical row.
 */
export interface LiveRunnerRegistration {
  runnerId: string;
  computerId: string;
  platform: string;
  architecture: string;
  features: RunnerFeature[];
  registeredAt: Date;
}

export interface RepositoryValidationEvent {
  /** Authenticated socket identity, never the payload's own field. */
  runnerId: string;
  computerId: string;
  platform: string;
  payload: RepositoryValidationPayload;
  receivedAt: Date;
}

export interface RunnerRegisteredEvent {
  runnerId: string;
  computerId: string;
  platform: string;
  features: RunnerFeature[];
  registeredAt: Date;
}

/**
 * Typed repository-handshake messages raised from the authenticated inbound
 * queue. The `runnerId` is the socket identity, never a payload field.
 */
export type RunnerProtocolEvent =
  | {
      type: 'execution.repository.accepted';
      runnerId: string;
      payload: ExecutionRepositoryAcceptedPayload;
      receivedAt: Date;
    }
  | {
      type: 'execution.repository.rejected';
      runnerId: string;
      payload: ExecutionRepositoryRejectedPayload;
      receivedAt: Date;
    }
  | {
      type: 'execution.start.rejected';
      runnerId: string;
      payload: ExecutionStartRejectedPayload;
      receivedAt: Date;
    }
  | {
      type: 'execution.accepted';
      runnerId: string;
      payload: ExecutionAcceptedPayload;
      receivedAt: Date;
    };

export interface ExecutionStartDispatchPayload {
  executionId: string;
  runtime: 'codex' | 'opencode';
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  projectId: string;
  prompt: string;
  options?: {
    model?: string | null;
    agent?: string | null;
    variant?: string | null;
    sandbox?: string | null;
    timeoutMs?: number;
  };
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_RECONNECT_GRACE_MS = 60_000;

/**
 * Owns runner identity, connection state and the server side of execution
 * dispatch. Durable state lives in SQLite; live socket state intentionally
 * stays in memory and is reconciled on reconnect.
 */
@Injectable()
export class RunnerRegistryService implements OnModuleInit, OnModuleDestroy {
  private transport: RunnerTransport | null = null;
  private readonly executionListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly repositoryValidationListeners = new Set<
    (event: RepositoryValidationEvent) => void
  >();
  private readonly protocolListeners = new Set<
    (event: RunnerProtocolEvent) => Promise<void> | void
  >();
  private readonly runnerRegisteredListeners = new Set<(event: RunnerRegisteredEvent) => void>();
  private readonly connections = new Map<string, RunnerConnectionInfo>();
  private readonly liveRegistrations = new Map<string, LiveRunnerRegistration>();
  private readonly seenMessages = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatTimeoutMs = Math.max(
    10_000,
    Number(process.env.HAFT_RUNNER_HEARTBEAT_TIMEOUT_MS ?? DEFAULT_HEARTBEAT_TIMEOUT_MS),
  );
  private readonly reconnectGraceMs = Math.max(
    5_000,
    Number(process.env.HAFT_RUNNER_RECONNECT_GRACE_MS ?? DEFAULT_RECONNECT_GRACE_MS),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    // A fresh API process has no live sockets. Persisted online state belongs
    // to the previous process and must not be trusted until a runner connects.
    await this.prisma.runner.updateMany({
      where: { status: { not: 'offline' } },
      data: { status: 'offline', disconnectedAt: new Date() },
    });

    this.heartbeatTimer = setInterval(() => {
      void this.expireStaleConnections().catch((error: unknown) => {
        this.logger.error({
          eventType: 'runner.heartbeat_check_failed',
          message: 'Runner heartbeat check failed',
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 10_000);
    this.heartbeatTimer.unref();

    // Never re-run an execution after an API restart. Keep it running and let
    // the runner reconnect and prove it still owns the process tree; if it
    // does not come back within the grace window, fail it with a concrete
    // recovery reason.
    const orphaned = await this.prisma.execution.findMany({
      where: { status: 'running', runnerId: { not: null } },
      select: { runnerId: true },
      distinct: ['runnerId'],
    });
    for (const row of orphaned) {
      if (row.runnerId) {
        this.scheduleRecoveryTimeout(row.runnerId);
      }
    }
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.recoveryTimers.clear();
    this.connections.clear();
    this.liveRegistrations.clear();
    this.executionListeners.clear();
    this.repositoryValidationListeners.clear();
    this.protocolListeners.clear();
    this.runnerRegisteredListeners.clear();
  }

  setTransport(transport: RunnerTransport): void {
    this.transport = transport;
  }

  getBootstrapToken(): string | null {
    return process.env.HAFT_RUNNER_BOOTSTRAP_TOKEN?.trim() || null;
  }

  getHeartbeatIntervalMs(): number {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  getReconnectGraceMs(): number {
    return this.reconnectGraceMs;
  }

  onExecutionEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.executionListeners.add(listener);
    return () => this.executionListeners.delete(listener);
  }

  onRepositoryValidation(listener: (event: RepositoryValidationEvent) => void): () => void {
    this.repositoryValidationListeners.add(listener);
    return () => this.repositoryValidationListeners.delete(listener);
  }

  onProtocolEvent(listener: (event: RunnerProtocolEvent) => Promise<void> | void): () => void {
    this.protocolListeners.add(listener);
    return () => this.protocolListeners.delete(listener);
  }

  onRunnerRegistered(listener: (event: RunnerRegisteredEvent) => void): () => void {
    this.runnerRegisteredListeners.add(listener);
    return () => this.runnerRegisteredListeners.delete(listener);
  }

  getLiveRegistration(runnerId: string): LiveRunnerRegistration | null {
    const registration = this.liveRegistrations.get(runnerId);
    if (!registration) return null;
    return { ...registration, features: [...registration.features] };
  }

  hasLiveFeatures(runnerId: string, required: readonly RunnerFeature[]): boolean {
    const registration = this.liveRegistrations.get(runnerId);
    if (!registration) return false;
    return required.every((feature) => registration.features.includes(feature));
  }

  async authenticate(input: RunnerHandshakeInput): Promise<RunnerHandshakeResult> {
    if (input.protocolVersion && input.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
      throw new AppException(
        'RUNNER_PROTOCOL_MISMATCH',
        `Runner protocol ${input.protocolVersion} is not supported; expected ${RUNNER_PROTOCOL_VERSION}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const computer = await this.prisma.computer.findUnique({
      where: { id: input.computerId },
      select: { id: true },
    });
    if (!computer) {
      throw new AppException(
        'COMPUTER_NOT_FOUND',
        'Runner computer is not registered on this server',
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.prisma.runner.findUnique({
      where: { id: input.runnerId },
    });

    if (input.token) {
      if (!existing || !this.verifyToken(input.token, existing.tokenHash)) {
        throw new AppException(
          'RUNNER_AUTH_FAILED',
          'Invalid runner token; pair the runner again with a bootstrap token',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (existing.computerId !== input.computerId) {
        throw new AppException(
          'RUNNER_AUTH_FAILED',
          'Runner token does not belong to this computer',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (existing.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
        throw new AppException(
          'RUNNER_PROTOCOL_MISMATCH',
          'Runner protocol version changed; pair the runner again',
          HttpStatus.BAD_REQUEST,
        );
      }
      return {
        runnerId: existing.id,
        computerId: existing.computerId,
        issuedToken: null,
        protocolVersion: existing.protocolVersion,
      };
    }

    const bootstrap = this.getBootstrapToken();
    if (!bootstrap || !input.bootstrapToken || !safeEqual(bootstrap, input.bootstrapToken)) {
      throw new AppException(
        'RUNNER_AUTH_FAILED',
        'A valid bootstrap token is required to pair a runner',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const issuedToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(issuedToken);
    if (existing) {
      await this.prisma.runner.update({
        where: { id: existing.id },
        data: {
          computerId: input.computerId,
          tokenHash,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
        },
      });
    } else {
      await this.prisma.runner.create({
        data: {
          id: input.runnerId,
          computerId: input.computerId,
          tokenHash,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          status: 'offline',
        },
      });
    }
    this.logger.info({
      eventType: 'runner.paired',
      message: 'Runner paired with bootstrap token',
      runnerId: input.runnerId,
      status: 'offline',
    });
    return {
      runnerId: input.runnerId,
      computerId: input.computerId,
      issuedToken,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    };
  }

  async markConnected(input: {
    runnerId: string;
    computerId: string;
    socketId: string;
  }): Promise<void> {
    this.clearRecoveryTimeout(input.runnerId);
    // A live socket starts with no trusted feature set until its register
    // message arrives; never reuse features from a previous connection.
    this.liveRegistrations.delete(input.runnerId);
    const now = new Date();
    this.connections.set(input.runnerId, {
      runnerId: input.runnerId,
      computerId: input.computerId,
      socketId: input.socketId,
      connectedAt: now,
    });
    await this.prisma.runner.updateMany({
      where: { id: input.runnerId },
      data: {
        status: 'online',
        connectedAt: now,
        disconnectedAt: null,
        lastHeartbeatAt: now,
      },
    });
    await this.prisma.computer.updateMany({
      where: { id: input.computerId },
      data: { status: 'online', lastSeenAt: now },
    });
    this.logger.info({
      eventType: 'runner.connected',
      message: 'Runner connected',
      runnerId: input.runnerId,
      status: 'online',
    });
  }

  async markDisconnected(runnerId: string, socketId?: string): Promise<void> {
    const existing = this.connections.get(runnerId);
    if (existing && socketId && existing.socketId !== socketId) {
      return;
    }
    this.connections.delete(runnerId);
    this.liveRegistrations.delete(runnerId);
    const now = new Date();
    await this.prisma.runner.updateMany({
      where: { id: runnerId },
      data: { status: 'offline', disconnectedAt: now },
    });
    this.logger.warn({
      eventType: 'runner.disconnected',
      message:
        'Runner disconnected; running executions stay alive during the recovery grace window',
      runnerId,
      status: 'offline',
    });
    this.scheduleRecoveryTimeout(runnerId);
  }

  async register(
    runnerId: string,
    payload: {
      computerId: string;
      runnerVersion: string;
      platform: string;
      architecture: string;
      capabilities: RunnerCapabilities;
    },
  ): Promise<void> {
    const existing = await this.findRunner(runnerId);
    if (!existing) {
      throw new AppException('RUNNER_NOT_FOUND', 'Runner is not paired', HttpStatus.NOT_FOUND);
    }
    if (existing.computerId !== payload.computerId) {
      throw new AppException(
        'RUNNER_AUTH_FAILED',
        'Runner registration computer mismatch',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const maxConcurrent = Math.min(
      32,
      Math.max(
        1,
        payload.capabilities.maxConcurrentExecutions ?? existing.maxConcurrentExecutions ?? 1,
      ),
    );
    await this.prisma.runner.update({
      where: { id: existing.id },
      data: {
        runnerVersion: payload.runnerVersion,
        platform: payload.platform,
        architecture: payload.architecture,
        capabilitiesJson: JSON.stringify({
          runtimes: payload.capabilities.runtimes,
          projectIds: payload.capabilities.projectIds,
          maxConcurrentExecutions: maxConcurrent,
          features: payload.capabilities.features ?? [],
        }),
        maxConcurrentExecutions: maxConcurrent,
        status: 'online',
        lastHeartbeatAt: new Date(),
      },
    });

    this.liveRegistrations.set(runnerId, {
      runnerId,
      computerId: payload.computerId,
      platform: payload.platform,
      architecture: payload.architecture,
      // Missing `features` means the empty set, never "supports everything".
      features: [...new Set(payload.capabilities.features ?? [])],
      registeredAt: new Date(),
    });

    const event: RunnerRegisteredEvent = {
      runnerId,
      computerId: payload.computerId,
      platform: payload.platform,
      features: [...new Set(payload.capabilities.features ?? [])],
      registeredAt: new Date(),
    };
    for (const listener of [...this.runnerRegisteredListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({
          eventType: 'runner.registration_listener_failed',
          message: 'Runner registration listener threw',
          runnerId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Tell the runner what the server believes is still running. `start_sent`
    // is included so a reconnect can reconcile an accepted start; pre-start
    // dispatch states are owned by the repository handshake service.
    const running = await this.prisma.execution.findMany({
      where: { runnerId, status: 'running', dispatchState: { in: ['start_sent', 'running'] } },
      select: { id: true },
    });
    if (running.length > 0) {
      this.dispatchReconcile(
        runnerId,
        'reconnect',
        running.map((execution) => execution.id),
      );
    }
  }

  async heartbeat(
    runnerId: string,
    payload: { activeExecutionIds: string[]; status: 'online' | 'busy' | 'degraded' },
  ): Promise<void> {
    const now = new Date();
    const status: RunnerStatus =
      payload.status === 'busy' ? 'busy' : payload.status === 'degraded' ? 'degraded' : 'online';
    if (!this.connections.has(runnerId)) {
      return;
    }
    const updated = await this.prisma.runner.updateMany({
      where: { id: runnerId },
      data: { status, lastHeartbeatAt: now },
    });
    if (updated.count === 0) {
      throw new AppException(
        'RUNNER_NOT_FOUND',
        'Runner is no longer paired; pair it again with the bootstrap token',
        HttpStatus.NOT_FOUND,
      );
    }
    const connection = this.connections.get(runnerId);
    if (connection) {
      await this.prisma.computer.updateMany({
        where: { id: connection.computerId },
        data: { status: 'online', lastSeenAt: now },
      });
    }
  }

  async handleInbound(runnerId: string, message: RunnerInboundMessage): Promise<void> {
    if (message.runnerId !== runnerId) {
      return;
    }
    if (this.isDuplicate(message.messageId)) {
      return;
    }

    if (message.type === 'runner.register') {
      await this.register(runnerId, message.payload);
    } else if (message.type === 'runner.heartbeat') {
      await this.heartbeat(runnerId, message.payload);
    } else if (message.type === 'runner.snapshot') {
      await this.reconcileSnapshot(runnerId, message.payload);
    } else if (message.type === 'repository.validation') {
      this.emitRepositoryValidation(runnerId, message.payload);
    } else if (message.type === 'execution.repository.accepted') {
      if (!(await this.ownsExecution(runnerId, message.payload.executionId))) {
        return;
      }
      await this.emitProtocolEvent({
        type: message.type,
        runnerId,
        payload: message.payload,
        receivedAt: new Date(),
      });
    } else if (message.type === 'execution.repository.rejected') {
      if (!(await this.ownsExecution(runnerId, message.payload.executionId))) {
        return;
      }
      await this.emitProtocolEvent({
        type: message.type,
        runnerId,
        payload: message.payload,
        receivedAt: new Date(),
      });
    } else if (message.type === 'execution.start.rejected') {
      if (!(await this.ownsExecution(runnerId, message.payload.executionId))) {
        return;
      }
      await this.emitProtocolEvent({
        type: message.type,
        runnerId,
        payload: message.payload,
        receivedAt: new Date(),
      });
    } else if (message.type === 'execution.accepted') {
      if (!(await this.ownsExecution(runnerId, message.payload.executionId))) {
        return;
      }
      await this.emitProtocolEvent({
        type: message.type,
        runnerId,
        payload: message.payload,
        receivedAt: new Date(),
      });
    } else if (message.type === 'execution.phase') {
      if (!(await this.ownsExecution(runnerId, message.payload.executionId))) {
        return;
      }
      this.emit({
        type: 'phase',
        executionId: message.payload.executionId,
        phase: message.payload.phase,
        message: message.payload.message ?? null,
      });
    } else if (message.type === 'execution.log') {
      if (!(await this.ownsExecution(runnerId, message.payload.executionId))) {
        return;
      }
      for (const entry of message.payload.entries) {
        this.emit({
          type: 'log',
          executionId: message.payload.executionId,
          level: entry.level,
          message: entry.message,
          seq: entry.sequence,
          stream: entry.stream,
          eventId: entry.eventId,
          runnerSeq: entry.sequence,
          timestamp: entry.timestamp,
        });
      }
    } else if (message.type === 'execution.progress') {
      if (!(await this.ownsExecution(runnerId, message.payload.executionId))) {
        return;
      }
      this.emit({
        type: 'progress',
        executionId: message.payload.executionId,
        progress: message.payload.progress,
        step: message.payload.step,
        progressMode: message.payload.progressMode,
      });
    } else if (message.type === 'execution.completed') {
      if (!(await this.ownsRunningExecution(runnerId, message.payload.executionId))) {
        return;
      }
      this.emit({
        type: 'completed',
        executionId: message.payload.executionId,
        exitCode: message.payload.exitCode,
        summary: message.payload.summary,
        git: message.payload.git,
      });
    } else if (message.type === 'execution.failed') {
      if (!(await this.ownsRunningExecution(runnerId, message.payload.executionId))) {
        return;
      }
      this.emit({
        type: 'failed',
        executionId: message.payload.executionId,
        reason: message.payload.reason,
        exitCode: message.payload.exitCode,
        summary: message.payload.summary,
        git: message.payload.git,
      });
    } else if (message.type === 'execution.cancelled') {
      if (!(await this.ownsRunningExecution(runnerId, message.payload.executionId))) {
        return;
      }
      this.emit({
        type: 'cancelled',
        executionId: message.payload.executionId,
        reason: message.payload.reason,
        exitCode: message.payload.exitCode,
        git: message.payload.git,
      });
    }

    this.rememberMessage(message.messageId);
  }

  /**
   * Sends (or retries) `execution.repository` with the caller-supplied stable
   * message id. Retries must reuse the exact same envelope.
   */
  sendExecutionRepository(
    runnerId: string,
    payload: ExecutionRepositoryPayload,
    messageId: string,
  ): boolean {
    if (!this.transport?.isConnected(runnerId)) {
      return false;
    }
    return this.transport.send(
      runnerId,
      this.envelopeWithId(runnerId, 'execution.repository', payload, messageId),
    );
  }

  /** Sends a pre-built envelope so handshake retries are byte-identical. */
  sendEnvelope(runnerId: string, message: RunnerEnvelope): boolean {
    if (!this.transport?.isConnected(runnerId)) {
      return false;
    }
    return this.transport.send(runnerId, message);
  }

  buildEnvelope(
    runnerId: string,
    type: string,
    payload: unknown,
    messageId: string = randomUUID(),
  ): RunnerEnvelope {
    return this.envelopeWithId(runnerId, type, payload, messageId);
  }

  sendExecutionStart(runnerId: string, payload: ExecutionStartDispatchPayload): boolean {
    if (!this.transport?.isConnected(runnerId)) {
      return false;
    }
    return this.transport.send(
      runnerId,
      this.envelope(runnerId, 'execution.start', {
        executionId: payload.executionId,
        runtime: payload.runtime,
        taskId: payload.taskId,
        taskTitle: payload.taskTitle,
        taskDescription: payload.taskDescription,
        projectId: payload.projectId,
        prompt: payload.prompt,
        options: payload.options ?? {},
      }),
    );
  }

  /**
   * Narrow public bridge for recovered handshake failures. It lets the
   * handshake service feed the existing runtime-event listener chain without
   * exposing the private emitter or injecting RuntimeRegistryService.
   */
  publishExecutionEvent(event: RuntimeEvent): void {
    this.emit(event);
  }

  dispatchCancel(runnerId: string, executionId: string, reason?: string): boolean {
    if (!this.transport?.isConnected(runnerId)) {
      return false;
    }
    return this.transport.send(
      runnerId,
      this.envelope(runnerId, 'execution.cancel', { executionId, reason }),
    );
  }

  dispatchReconcile(
    runnerId: string,
    reason: 'server_restart' | 'reconnect' | 'manual',
    executionIds: string[],
  ): boolean {
    if (!this.transport?.isConnected(runnerId)) {
      return false;
    }
    return this.transport.send(
      runnerId,
      this.envelope(runnerId, 'execution.reconcile', { reason, executionIds }),
    );
  }

  sendRepositoryValidate(
    runnerId: string,
    payload: RepositoryValidatePayload,
    messageId: string = randomUUID(),
  ): boolean {
    if (!this.transport?.isConnected(runnerId)) {
      return false;
    }
    return this.transport.send(
      runnerId,
      this.envelopeWithId(runnerId, 'repository.validate', payload, messageId),
    );
  }

  sendLogAck(runnerId: string, executionId: string, throughSeq: number): void {
    if (!this.transport?.isConnected(runnerId)) {
      return;
    }
    this.transport.send(
      runnerId,
      this.envelope(runnerId, 'execution.log.ack', { executionId, throughSeq }),
    );
  }

  async list(): Promise<ReturnType<typeof toRunnerDto>[]> {
    const runners = await this.prisma.runner.findMany({
      include: { computer: true },
      orderBy: { createdAt: 'asc' },
    });
    return runners.map(toRunnerDto);
  }

  async findByComputer(computerId: string): Promise<ReturnType<typeof toRunnerDto> | null> {
    const runner = await this.prisma.runner.findFirst({
      where: { computerId },
      include: { computer: true },
    });
    return runner ? toRunnerDto(runner) : null;
  }

  isConnected(runnerId: string): boolean {
    return this.connections.has(runnerId) && Boolean(this.transport?.isConnected(runnerId));
  }

  private async reconcileSnapshot(
    runnerId: string,
    payload: { executions: Array<{ executionId: string; lastSeq: number }> },
  ): Promise<void> {
    const running = await this.prisma.execution.findMany({
      where: {
        runnerId,
        status: 'running',
        dispatchState: { in: ['start_sent', 'running'] },
      },
      select: { id: true, createdAt: true, dispatchState: true },
    });
    const serverIds = new Set(running.map((execution) => execution.id));
    const reportedIds = new Set(payload.executions.map((execution) => execution.executionId));
    // A snapshot is captured when the runner connects. An execution the server
    // created after that connection was established cannot be in the snapshot
    // yet, even if it is already marked running in the database. Failing it as
    // "restarted" would abort a healthy dispatch.
    const connectedAt = this.connections.get(runnerId)?.connectedAt ?? null;

    for (const execution of payload.executions) {
      if (!serverIds.has(execution.executionId)) {
        this.logger.warn({
          eventType: 'runner.orphan_cancelled',
          message: 'Runner reported an execution the server does not consider running',
          runnerId,
          executionId: execution.executionId,
          status: 'warning',
        });
        this.dispatchCancel(
          runnerId,
          execution.executionId,
          'Execution is not running on the server',
        );
      }
    }

    for (const execution of running) {
      if (reportedIds.has(execution.id)) {
        continue;
      }
      if (connectedAt && execution.createdAt.getTime() >= connectedAt.getTime()) {
        this.logger.info({
          eventType: 'runner.execution_pending',
          message:
            'Execution started after this runner connection; keeping it while the snapshot settles',
          runnerId,
          executionId: execution.id,
          status: 'running',
        });
        continue;
      }
      if (execution.dispatchState === 'start_sent') {
        // WP-D owns the 30 s RUNNER_START_UNCONFIRMED grace. WP-C must not
        // report RUNNER_RESTARTED for an execution whose CLI never started.
        this.logger.warn({
          eventType: 'runner.start_unconfirmed_pending',
          message:
            'Execution start is unconfirmed; recovery grace is handled by the handshake service',
          runnerId,
          executionId: execution.id,
          status: 'warning',
        });
        continue;
      }
      this.logger.warn({
        eventType: 'runner.execution_lost',
        message: 'Runner no longer owns a running execution; failing it without re-running',
        runnerId,
        executionId: execution.id,
        status: 'warning',
      });
      this.emit({
        type: 'failed',
        executionId: execution.id,
        reason: 'RUNNER_RESTARTED',
        exitCode: null,
        summary: null,
        git: null,
      });
    }

    const shared = [...serverIds].filter((executionId) => reportedIds.has(executionId));
    if (shared.length > 0) {
      this.dispatchReconcile(runnerId, 'reconnect', shared);
    }
  }

  private async ownsExecution(runnerId: string, executionId: string): Promise<boolean> {
    const execution = await this.prisma.execution.findUnique({
      where: { id: executionId },
      select: { runnerId: true },
    });
    if (!execution || execution.runnerId !== runnerId) {
      this.logger.warn({
        eventType: 'runner.execution_rejected',
        message: 'Runner sent an event for an execution it does not own',
        runnerId,
        executionId,
        status: 'warning',
      });
      return false;
    }
    return true;
  }

  private async ownsRunningExecution(runnerId: string, executionId: string): Promise<boolean> {
    const execution = await this.prisma.execution.findUnique({
      where: { id: executionId },
      select: { runnerId: true, status: true },
    });
    return Boolean(execution && execution.runnerId === runnerId && execution.status === 'running');
  }

  private scheduleRecoveryTimeout(runnerId: string): void {
    this.clearRecoveryTimeout(runnerId);
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(runnerId);
      if (this.isConnected(runnerId)) {
        return;
      }
      void this.failOrphanedExecutions(runnerId, 'RUNNER_DISCONNECTED').catch((error: unknown) => {
        this.logger.error({
          eventType: 'runner.recovery_failed',
          message: 'Failed to finalize executions after the recovery grace window',
          runnerId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.reconnectGraceMs);
    timer.unref();
    this.recoveryTimers.set(runnerId, timer);
  }

  private clearRecoveryTimeout(runnerId: string): void {
    const timer = this.recoveryTimers.get(runnerId);
    if (timer) {
      clearTimeout(timer);
      this.recoveryTimers.delete(runnerId);
    }
  }

  private async failOrphanedExecutions(runnerId: string, reason: string): Promise<void> {
    if (this.isConnected(runnerId)) {
      return;
    }
    const running = await this.prisma.execution.findMany({
      where: { runnerId, status: 'running' },
      select: { id: true },
    });
    for (const execution of running) {
      this.emit({
        type: 'failed',
        executionId: execution.id,
        reason,
        exitCode: null,
        summary: null,
        git: null,
      });
    }
  }

  private async findRunner(runnerId: string) {
    return this.prisma.runner.findUnique({ where: { id: runnerId } });
  }

  private async emitProtocolEvent(event: RunnerProtocolEvent): Promise<void> {
    for (const listener of [...this.protocolListeners]) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error({
          eventType: 'runner.protocol_listener_failed',
          message: 'Protocol event listener threw while handling a handshake message',
          runnerId: event.runnerId,
          executionId: event.payload.executionId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.executionListeners]) {
      listener(event);
    }
  }

  private emitRepositoryValidation(runnerId: string, payload: RepositoryValidationPayload): void {
    const connection = this.connections.get(runnerId);
    const registration = this.liveRegistrations.get(runnerId);
    if (!connection || !registration || registration.runnerId !== runnerId) {
      this.logger.warn({
        eventType: 'repository.validation_rejected',
        message: 'Validation response arrived without a live authenticated registration',
        runnerId,
        status: 'warning',
      });
      return;
    }
    const event: RepositoryValidationEvent = {
      runnerId,
      computerId: connection.computerId,
      platform: registration.platform,
      payload,
      receivedAt: new Date(),
    };
    for (const listener of [...this.repositoryValidationListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({
          eventType: 'repository.validation_listener_failed',
          message: 'Repository validation listener threw while handling a response',
          runnerId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private envelope(
    runnerId: string,
    type: string,
    payload: Record<string, unknown>,
  ): RunnerEnvelope {
    return this.envelopeWithId(runnerId, type, payload, randomUUID());
  }

  private envelopeWithId(
    runnerId: string,
    type: string,
    payload: unknown,
    messageId: string,
  ): RunnerEnvelope {
    return {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      messageId,
      runnerId,
      type,
      sentAt: new Date().toISOString(),
      payload,
    };
  }

  private verifyToken(token: string, tokenHash: string): boolean {
    return safeEqual(hashToken(token), tokenHash);
  }

  private isDuplicate(messageId: string): boolean {
    const seenAt = this.seenMessages.get(messageId);
    return Boolean(seenAt && Date.now() - seenAt < 10 * 60_000);
  }

  private rememberMessage(messageId: string): void {
    const now = Date.now();
    this.seenMessages.set(messageId, now);
    if (this.seenMessages.size > 10_000) {
      for (const [key, timestamp] of this.seenMessages) {
        if (now - timestamp > 10 * 60_000) this.seenMessages.delete(key);
      }
    }
  }

  private async expireStaleConnections(): Promise<void> {
    if (this.connections.size === 0) return;
    const now = Date.now();
    const stale: string[] = [];
    for (const [runnerId, connection] of this.connections) {
      const row = await this.prisma.runner.findUnique({
        where: { id: runnerId },
        select: { lastHeartbeatAt: true },
      });
      const last = row?.lastHeartbeatAt?.getTime() ?? connection.connectedAt.getTime();
      if (now - last > this.heartbeatTimeoutMs) {
        stale.push(runnerId);
      }
    }
    for (const runnerId of stale) {
      await this.markDisconnected(runnerId, this.connections.get(runnerId)?.socketId);
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
