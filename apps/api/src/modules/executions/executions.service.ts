import {
  HttpStatus,
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  AgentDto,
  CancelExecutionInput,
  ExecutionDto,
  ExecutionListQuery,
  ExecutionLogDto,
  ExecutionLogsQuery,
  ListDto,
  TaskCancellationDto,
  TaskDto,
} from '@raft-lite/contracts';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { AppLogger } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  agentRelations,
  executionRelations,
  taskRelations,
  toAgentDto,
  toExecutionDto,
  toExecutionLogDto,
  toTaskDto,
} from '../../common/serializers';
import { ActivitiesService } from '../activities/activities.service';
import { EventsGateway } from '../events/events.gateway';
import {
  AGENT_RUNTIME,
  type AgentRuntime,
  type RuntimeEvent,
} from '../runtime/agent-runtime.interface';

@Injectable()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private readonly locks = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly events: EventsGateway,
    private readonly logger: AppLogger,
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.runtime.onEvent((event) => {
      void this.withExecutionLock(event.executionId, () => this.handleRuntimeEvent(event)).catch(
        (error: unknown) => {
          this.logger.error({
            eventType: 'runtime.event_failed',
            message: 'Failed to persist runtime event',
            executionId: event.executionId,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /**
   * Starts are serialized in-process because the running-execution checks and
   * the creation transaction are separate statements. This is sufficient for
   * the single-instance SQLite demo; multiple API instances would need a
   * database-level guard as well.
   */
  async startForTask(taskId: string): Promise<ExecutionDto> {
    return this.withLock('execution-start', () => this.startForTaskLocked(taskId));
  }

  private async startForTaskLocked(taskId: string): Promise<ExecutionDto> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: taskRelations,
    });
    if (!task) {
      throw new AppException('TASK_NOT_FOUND', 'Task not found', HttpStatus.NOT_FOUND);
    }
    const active = await this.prisma.execution.findFirst({
      where: { taskId, status: 'running' },
    });
    if (active) {
      throw new AppException(
        'EXECUTION_ALREADY_RUNNING',
        'This task already has a running execution',
        HttpStatus.CONFLICT,
        { executionId: active.id },
      );
    }
    if (!task.assigneeAgentId || !task.assignee) {
      throw new AppException(
        'TASK_UNASSIGNED',
        'Assign an agent before starting an execution',
        HttpStatus.CONFLICT,
      );
    }
    const assigneeAgentId = task.assigneeAgentId;
    if (!['todo', 'claimed', 'in_progress'].includes(task.status)) {
      throw new AppException(
        'TASK_NOT_STARTABLE',
        'Only todo, claimed, or in-progress tasks can start an execution',
        HttpStatus.CONFLICT,
      );
    }
    const agentBusy = await this.prisma.execution.findFirst({
      where: { agentId: assigneeAgentId, status: 'running' },
    });
    if (agentBusy) {
      throw new AppException(
        'AGENT_BUSY',
        'The assigned agent is already running another execution',
        HttpStatus.CONFLICT,
        { executionId: agentBusy.id },
      );
    }
    if (task.assignee.status === 'offline') {
      throw new AppException('AGENT_OFFLINE', 'The assigned agent is offline', HttpStatus.CONFLICT);
    }
    if (task.assignee.status === 'error') {
      throw new AppException(
        'AGENT_ERROR',
        'Reset the assigned agent to Idle before starting a new execution',
        HttpStatus.CONFLICT,
      );
    }
    if (task.assignee.status === 'busy') {
      throw new AppException('AGENT_BUSY', 'The assigned agent is busy', HttpStatus.CONFLICT);
    }
    if (task.assignee.runtime !== 'mock') {
      throw new AppException(
        'RUNTIME_NOT_AVAILABLE',
        `${task.assignee.runtime} runtime is reserved but not connected in this phase`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const execution = await this.prisma.$transaction(async (tx) => {
      const created = await tx.execution.create({
        data: {
          taskId,
          agentId: assigneeAgentId,
          runtime: 'mock',
          status: 'running',
          progress: 0,
        },
        include: executionRelations,
      });
      await tx.task.update({
        where: { id: taskId },
        data: { status: 'in_progress' },
      });
      await tx.agent.update({
        where: { id: assigneeAgentId },
        data: { status: 'busy', lastActiveAt: new Date() },
      });
      return created;
    });

    const executionDto = toExecutionDto(execution);
    const [taskDto, agentDto] = await Promise.all([
      this.getTaskDto(taskId),
      this.getAgentDto(assigneeAgentId),
    ]);

    await this.activities.record({
      type: 'execution.started',
      summary: `${executionDto.agent.name} started “${task.title}”`,
      taskId,
      agentId: assigneeAgentId,
      executionId: execution.id,
    });
    this.events.emitTaskUpdated(taskDto);
    this.events.emitAgentUpdated(agentDto);
    this.events.emitExecutionUpdated(executionDto);
    this.logger.info({
      eventType: 'execution.started',
      message: 'Mock execution started',
      taskId,
      agentId: assigneeAgentId,
      executionId: execution.id,
      status: 'running',
    });

    try {
      await this.runtime.start({
        executionId: execution.id,
        taskId,
        taskTitle: task.title,
        agentId: assigneeAgentId,
        agentName: executionDto.agent.name,
      });
    } catch (error) {
      try {
        await this.failExecutionStart({
          executionId: execution.id,
          taskId,
          agentId: assigneeAgentId,
          previousTaskStatus: task.status,
          previousAgentStatus: task.assignee.status,
          previousAgentLastActiveAt: task.assignee.lastActiveAt,
          error,
        });
      } catch (rollbackError) {
        this.logger.error({
          eventType: 'runtime.start_rollback_failed',
          message: 'Failed to roll back a rejected execution start',
          taskId,
          agentId: assigneeAgentId,
          executionId: execution.id,
          status: 'failed',
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      await this.runtime.stop(execution.id).catch(() => undefined);
      this.logger.error({
        eventType: 'runtime.start_failed',
        message: 'Runtime rejected execution start',
        taskId,
        agentId: assigneeAgentId,
        executionId: execution.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppException(
        'RUNTIME_START_FAILED',
        'The runtime could not start this execution',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return executionDto;
  }

  async list(query: ExecutionListQuery): Promise<ListDto<ExecutionDto>> {
    const where: Prisma.ExecutionWhereInput = {
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.execution.findMany({
        where,
        include: executionRelations,
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        take: query.limit ?? 50,
      }),
      this.prisma.execution.count({ where }),
    ]);
    return { items: records.map(toExecutionDto), total };
  }

  async findOne(id: string): Promise<ExecutionDto> {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      include: executionRelations,
    });
    if (!execution) {
      throw new AppException('EXECUTION_NOT_FOUND', 'Execution not found', HttpStatus.NOT_FOUND);
    }
    return toExecutionDto(execution);
  }

  async logs(id: string, query: ExecutionLogsQuery): Promise<ListDto<ExecutionLogDto>> {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!execution) {
      throw new AppException('EXECUTION_NOT_FOUND', 'Execution not found', HttpStatus.NOT_FOUND);
    }
    const where: Prisma.ExecutionLogWhereInput = {
      executionId: id,
      ...(query.afterSeq !== undefined ? { seq: { gt: query.afterSeq } } : {}),
    };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.executionLog.findMany({
        where,
        orderBy: { seq: 'asc' },
        take: query.limit ?? 200,
      }),
      this.prisma.executionLog.count({ where }),
    ]);
    return { items: records.map(toExecutionLogDto), total };
  }

  async cancel(id: string, input?: CancelExecutionInput): Promise<ExecutionDto> {
    return this.withExecutionLock(id, async () => {
      const execution = await this.prisma.execution.findUnique({
        where: { id },
        include: executionRelations,
      });
      if (!execution) {
        throw new AppException('EXECUTION_NOT_FOUND', 'Execution not found', HttpStatus.NOT_FOUND);
      }
      if (execution.status !== 'running') {
        throw new AppException(
          'EXECUTION_NOT_RUNNING',
          'Only a running execution can be cancelled',
          HttpStatus.CONFLICT,
        );
      }
      await this.runtime.stop(id);
      const reason = input?.reason ?? 'Cancelled by operator';
      const endedAt = new Date();

      await this.prisma.$transaction([
        this.prisma.execution.update({
          where: { id },
          data: { status: 'cancelled', endedAt, cancelReason: reason },
        }),
        this.prisma.task.update({
          where: { id: execution.taskId },
          data: { status: 'cancelled' },
        }),
        this.prisma.agent.update({
          where: { id: execution.agentId },
          data: { status: 'idle', lastActiveAt: endedAt },
        }),
      ]);

      await this.appendLog(id, 'warning', `Execution cancelled: ${reason}`);

      const [updatedExecution, taskDto, agentDto] = await Promise.all([
        this.getExecutionDto(id),
        this.getTaskDto(execution.taskId),
        this.getAgentDto(execution.agentId),
      ]);
      this.events.emitExecutionUpdated(updatedExecution);
      this.events.emitTaskUpdated(taskDto);
      this.events.emitAgentUpdated(agentDto);
      await this.activities.record({
        type: 'execution.cancelled',
        summary: `${updatedExecution.agent.name} stopped “${updatedExecution.task.title}”`,
        taskId: execution.taskId,
        agentId: execution.agentId,
        executionId: id,
        metadata: { reason },
      });
      this.logger.info({
        eventType: 'execution.cancelled',
        message: 'Execution cancelled by operator',
        taskId: execution.taskId,
        agentId: execution.agentId,
        executionId: id,
        status: 'cancelled',
      });
      return updatedExecution;
    });
  }

  async cancelTask(taskId: string, input?: CancelExecutionInput): Promise<TaskCancellationDto> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new AppException('TASK_NOT_FOUND', 'Task not found', HttpStatus.NOT_FOUND);
    }
    if (task.status === 'done') {
      throw new AppException(
        'TASK_TERMINAL',
        'A completed task cannot be cancelled',
        HttpStatus.CONFLICT,
      );
    }
    const active = await this.prisma.execution.findFirst({
      where: { taskId, status: 'running' },
    });
    if (active) {
      const execution = await this.cancel(active.id, input);
      const updated = await this.getTaskDto(taskId);
      return { task: updated, execution };
    }
    if (task.status === 'cancelled') {
      const current = await this.getTaskDto(taskId);
      return { task: current, execution: null };
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'cancelled' },
      include: taskRelations,
    });
    const taskDto = toTaskDto(updated);
    await this.activities.record({
      type: 'task.status_changed',
      summary: `Cancelled “${task.title}”`,
      taskId,
      agentId: task.assigneeAgentId,
      metadata: { from: task.status, to: 'cancelled' },
    });
    this.events.emitTaskUpdated(taskDto);
    this.logger.info({
      eventType: 'task.cancelled',
      message: `Task ${task.title} cancelled`,
      taskId,
      agentId: task.assigneeAgentId ?? undefined,
      status: 'cancelled',
    });
    return { task: taskDto, execution: null };
  }

  private async failExecutionStart(input: {
    executionId: string;
    taskId: string;
    agentId: string;
    previousTaskStatus: string;
    previousAgentStatus: string;
    previousAgentLastActiveAt: Date | null;
    error: unknown;
  }): Promise<void> {
    const endedAt = new Date();
    const failureReason = 'The runtime failed to start this execution';
    await this.prisma.$transaction([
      this.prisma.execution.update({
        where: { id: input.executionId },
        data: {
          status: 'failed',
          endedAt,
          failureReason,
        },
      }),
      this.prisma.task.update({
        where: { id: input.taskId },
        data: { status: input.previousTaskStatus },
      }),
      this.prisma.agent.update({
        where: { id: input.agentId },
        data: {
          status: input.previousAgentStatus,
          lastActiveAt: input.previousAgentLastActiveAt,
        },
      }),
    ]);

    await this.appendLog(input.executionId, 'error', `Execution failed to start: ${failureReason}`);
    const [executionDto, taskDto, agentDto] = await Promise.all([
      this.getExecutionDto(input.executionId),
      this.getTaskDto(input.taskId),
      this.getAgentDto(input.agentId),
    ]);
    this.events.emitExecutionUpdated(executionDto);
    this.events.emitTaskUpdated(taskDto);
    this.events.emitAgentUpdated(agentDto);
    await this.activities.record({
      type: 'execution.failed',
      summary: `${executionDto.agent.name} could not start “${executionDto.task.title}”`,
      taskId: input.taskId,
      agentId: input.agentId,
      executionId: input.executionId,
      metadata: {
        stage: 'start',
        error: input.error instanceof Error ? input.error.message : String(input.error),
      },
    });
  }

  private async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    switch (event.type) {
      case 'log':
        await this.handleLog(event);
        break;
      case 'progress':
        await this.handleProgress(event);
        break;
      case 'completed':
        await this.finishExecution(event.executionId, 'completed');
        break;
      case 'failed':
        await this.finishExecution(event.executionId, 'failed', event.reason);
        break;
    }
  }

  private async handleLog(event: Extract<RuntimeEvent, { type: 'log' }>): Promise<void> {
    const execution = await this.prisma.execution.findUnique({
      where: { id: event.executionId },
      select: { id: true, status: true },
    });
    if (!execution || execution.status !== 'running') {
      return;
    }
    const log = await this.prisma.executionLog.create({
      data: {
        executionId: event.executionId,
        seq: event.seq,
        level: event.level,
        message: event.message,
      },
    });
    this.events.emitExecutionLog(toExecutionLogDto(log));
  }

  private async handleProgress(event: Extract<RuntimeEvent, { type: 'progress' }>): Promise<void> {
    const result = await this.prisma.execution.updateMany({
      where: { id: event.executionId, status: 'running' },
      data: { progress: Math.min(100, Math.max(0, event.progress)) },
    });
    if (result.count === 0) {
      return;
    }
    const execution = await this.getExecutionDto(event.executionId);
    this.events.emitExecutionUpdated(execution);
  }

  private async finishExecution(
    id: string,
    outcome: 'completed' | 'failed',
    failureReason?: string,
  ): Promise<void> {
    const current = await this.prisma.execution.findUnique({
      where: { id },
      include: executionRelations,
    });
    if (!current || current.status !== 'running') {
      return;
    }
    const endedAt = new Date();
    const nextTaskStatus = outcome === 'completed' ? 'done' : 'failed';
    const nextAgentStatus = outcome === 'completed' ? 'idle' : 'error';

    await this.prisma.$transaction([
      this.prisma.execution.update({
        where: { id },
        data: {
          status: outcome,
          progress: outcome === 'completed' ? 100 : current.progress,
          endedAt,
          ...(failureReason ? { failureReason } : {}),
        },
      }),
      this.prisma.task.update({
        where: { id: current.taskId },
        data: { status: nextTaskStatus },
      }),
      this.prisma.agent.update({
        where: { id: current.agentId },
        data: { status: nextAgentStatus, lastActiveAt: endedAt },
      }),
    ]);

    const [executionDto, taskDto, agentDto] = await Promise.all([
      this.getExecutionDto(id),
      this.getTaskDto(current.taskId),
      this.getAgentDto(current.agentId),
    ]);
    this.events.emitExecutionUpdated(executionDto);
    this.events.emitTaskUpdated(taskDto);
    this.events.emitAgentUpdated(agentDto);

    await this.activities.record({
      type: outcome === 'completed' ? 'execution.completed' : 'execution.failed',
      summary:
        outcome === 'completed'
          ? `${executionDto.agent.name} completed “${executionDto.task.title}”`
          : `${executionDto.agent.name} failed “${executionDto.task.title}”`,
      taskId: current.taskId,
      agentId: current.agentId,
      executionId: id,
      metadata: failureReason ? { failureReason } : null,
    });
    this.logger.info({
      eventType: outcome === 'completed' ? 'execution.completed' : 'execution.failed',
      message: outcome === 'completed' ? 'Execution completed successfully' : 'Execution failed',
      taskId: current.taskId,
      agentId: current.agentId,
      executionId: id,
      status: outcome,
      ...(failureReason ? { error: failureReason } : {}),
    });
  }

  private async appendLog(
    executionId: string,
    level: 'info' | 'success' | 'warning' | 'error',
    message: string,
  ): Promise<void> {
    const aggregate = await this.prisma.executionLog.aggregate({
      where: { executionId },
      _max: { seq: true },
    });
    const seq = (aggregate._max.seq ?? 0) + 1;
    const log = await this.prisma.executionLog.create({
      data: { executionId, seq, level, message },
    });
    this.events.emitExecutionLog(toExecutionLogDto(log));
  }

  private async getExecutionDto(id: string): Promise<ExecutionDto> {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      include: executionRelations,
    });
    if (!execution) {
      throw new AppException('EXECUTION_NOT_FOUND', 'Execution not found', HttpStatus.NOT_FOUND);
    }
    return toExecutionDto(execution);
  }

  private async getTaskDto(id: string): Promise<TaskDto> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: taskRelations,
    });
    if (!task) {
      throw new AppException('TASK_NOT_FOUND', 'Task not found', HttpStatus.NOT_FOUND);
    }
    return toTaskDto(task);
  }

  private async getAgentDto(id: string): Promise<AgentDto> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: agentRelations,
    });
    if (!agent) {
      throw new AppException('AGENT_NOT_FOUND', 'Agent not found', HttpStatus.NOT_FOUND);
    }
    return toAgentDto(agent);
  }

  private withExecutionLock<T>(executionId: string, work: () => Promise<T>): Promise<T> {
    return this.withLock(`execution:${executionId}`, work);
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tracked = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tracked);
    try {
      return await result;
    } finally {
      if (this.locks.get(key) === tracked) {
        this.locks.delete(key);
      }
    }
  }
}
