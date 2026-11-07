import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  RunnerCapabilities,
  RunnerEnvelope,
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

export interface RunnerConnectionInfo {
  runnerId: string;
  computerId: string;
  socketId: string;
  connectedAt: Date;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const START_ACCEPT_TIMEOUT_MS = 20_000;
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
  private readonly connections = new Map<string, RunnerConnectionInfo>();
  private readonly seenMessages = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingStarts = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
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
    for (const pending of this.pendingStarts.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Runner registry is shutting down'));
    }
    this.pendingStarts.clear();
    this.connections.clear();
    this.executionListeners.clear();
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
    const now = new Date();
    await this.prisma.runner.updateMany({
      where: { id: runnerId },
      data: { status: 'offline', disconnectedAt: now },
    });
    this.logger.warn({
      eventType: 'runner.disconnected',
      message: 'Runner disconnected; running executions stay alive during the recovery grace window',
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
        }),
        maxConcurrentExecutions: maxConcurrent,
        status: 'online',
        lastHeartbeatAt: new Date(),
      },
    });

    // Tell the runner what the server believes is still running. The runner
    // answers with a snapshot, which is the authoritative local view.
    const running = await this.prisma.execution.findMany({
      where: { runnerId, status: 'running' },
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
    } else if (message.type === 'execution.accepted') {
      const key = pendingKey(runnerId, message.payload.executionId);
      const pending = this.pendingStarts.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingStarts.delete(key);
        pending.resolve();
      }
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

  async dispatchStart(input: {
    runnerId: string;
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
  }): Promise<void> {
    if (!this.transport?.isConnected(input.runnerId)) {
      throw new Error('The assigned runner is not connected');
    }
    const runner = await this.findRunner(input.runnerId);
    if (!runner) {
      throw new Error('The assigned runner is no longer paired');
    }
    const running = await this.prisma.execution.count({
      where: { runnerId: input.runnerId, status: 'running' },
    });
    if (running > runner.maxConcurrentExecutions) {
      throw new Error('The runner has reached its maximum concurrent executions');
    }

    const key = pendingKey(input.runnerId, input.executionId);
    if (this.pendingStarts.has(key)) {
      throw new Error('This execution is already being dispatched to the runner');
    }

    const message = this.envelope(input.runnerId, 'execution.start', {
      executionId: input.executionId,
      runtime: input.runtime,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription,
      projectId: input.projectId,
      prompt: input.prompt,
      options: input.options ?? {},
    });

    const accepted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStarts.delete(key);
        // The runner may have started the work but missed the acceptance
        // window (for example while blocked). Ask it to stop so a timed-out
        // dispatch cannot leave an unsupervised process behind.
        this.dispatchCancel(
          input.runnerId,
          input.executionId,
          'Execution start was not acknowledged by the runner in time',
        );
        reject(new Error('Runner did not accept the execution before the dispatch timeout'));
      }, START_ACCEPT_TIMEOUT_MS);
      timer.unref();
      this.pendingStarts.set(key, { resolve, reject, timer });
    });

    const sent = this.transport.send(input.runnerId, message);
    if (!sent) {
      const pending = this.pendingStarts.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingStarts.delete(key);
      }
      throw new Error('The assigned runner is not connected');
    }
    await accepted;
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
      where: { runnerId, status: 'running' },
      select: { id: true, createdAt: true },
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
          message: 'Execution started after this runner connection; keeping it while the snapshot settles',
          runnerId,
          executionId: execution.id,
          status: 'running',
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
    return Boolean(
      execution && execution.runnerId === runnerId && execution.status === 'running',
    );
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

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.executionListeners]) {
      listener(event);
    }
  }

  private envelope(
    runnerId: string,
    type: string,
    payload: Record<string, unknown>,
  ): RunnerEnvelope {
    return {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      messageId: randomUUID(),
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

function pendingKey(runnerId: string, executionId: string): string {
  return `${runnerId}:${executionId}`;
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
