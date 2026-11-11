import { HttpStatus, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ERROR_CODES,
  EXECUTION_DIFF_MAX_BYTES,
  type AgentDto,
  type AgentRuntimeType,
  type CancelExecutionInput,
  type ExecutionDiffDto,
  type ExecutionDto,
  type ExecutionListQuery,
  type ExecutionLogDto,
  type ExecutionLogsQuery,
  type ListDto,
  type TaskCancellationDto,
  type TaskDto,
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
  toExecutionDiffDto,
  toExecutionDto,
  toExecutionLogDto,
  toTaskDto,
  type ExecutionWithRelations,
} from '../../common/serializers';
import { ActivitiesService } from '../activities/activities.service';
import { EventsGateway } from '../events/events.gateway';
import type { RuntimeEvent } from '../runtime/agent-runtime.interface';
import { RuntimeRegistryService } from '../runtime/runtime-registry.service';
import { RepositoryHandshakeService } from '../runners/repository-handshake.service';
import { RepositoryDispatchError } from '../runners/repository-errors';

const RUNNER_CANCEL_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.HAFT_RUNNER_CANCEL_TIMEOUT_MS ?? 30_000),
);

@Injectable()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private readonly locks = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly events: EventsGateway,
    private readonly logger: AppLogger,
    private readonly runtimes: RuntimeRegistryService,
    private readonly handshake: RepositoryHandshakeService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.runtimes.onEvent((event) => {
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
    if (task.project.archivedAt) {
      throw new AppException(
        ERROR_CODES.PROJECT_ARCHIVED,
        'Archived projects cannot start new executions',
        HttpStatus.CONFLICT,
        {
          projectId: task.projectId,
          archivedAt: task.project.archivedAt.toISOString(),
        },
      );
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

    const runtimeType = task.assignee.runtime as AgentRuntimeType;
    const requiresRunner = runtimeType !== 'mock';
    let runnerId: string | null = null;
    let repositoryBinding: {
      id: string;
      bindingVersion: number;
      validatedBindingVersion: number | null;
      status: string;
      canonicalPath: string | null;
      policyVersion: string | null;
      platform: string | null;
      validatedByRunnerId: string | null;
    } | null = null;
    if (requiresRunner) {
      if (!task.assignee.computerId || !task.assignee.computer) {
        throw new AppException(
          'COMPUTER_NOT_ASSIGNED',
          'Assign the agent to a computer with a connected runner',
          HttpStatus.CONFLICT,
        );
      }
      if (task.assignee.computer.status === 'offline') {
        throw new AppException(
          'COMPUTER_OFFLINE',
          'The assigned computer is offline',
          HttpStatus.CONFLICT,
        );
      }
      repositoryBinding = await this.prisma.projectRepositoryBinding.findUnique({
        where: {
          projectId_computerId: {
            projectId: task.projectId,
            computerId: task.assignee.computerId,
          },
        },
        select: {
          id: true,
          bindingVersion: true,
          validatedBindingVersion: true,
          status: true,
          canonicalPath: true,
          policyVersion: true,
          platform: true,
          validatedByRunnerId: true,
        },
      });
      if (!repositoryBinding) {
        throw bindingMissing(task.projectId, task.assignee.computerId);
      }
      if (!isReadyBinding(repositoryBinding)) {
        throw bindingNotReady(repositoryBinding);
      }
      const availability = await this.runtimes.getAvailability(
        runtimeType,
        task.assignee.computerId,
        task.projectId,
      );
      if (!availability.available) {
        throw runtimeUnavailable(availability.reasonCode, availability.reason, runtimeType);
      }
      runnerId = availability.runnerId;
      if (!runnerId) {
        throw new AppException(
          'RUNNER_OFFLINE',
          'No connected runner is available for this execution',
          HttpStatus.CONFLICT,
        );
      }
      assertBindingRunnerIdentity(repositoryBinding, runnerId, this.runtimes);
    }

    const runnerComputerId = requiresRunner ? task.assignee.computerId : null;

    const execution = await this.prisma.$transaction(async (tx) => {
      // The pre-check above runs outside the transaction. Re-read the archived
      // flag, the default branch, and the binding inside the same transaction
      // that creates the Execution so a concurrent archive, branch change, path
      // change, or re-validation cannot leak into a stale execution snapshot.
      const projectState = await tx.project.findUnique({
        where: { id: task.projectId },
        select: { archivedAt: true, defaultBranch: true },
      });
      if (!projectState || projectState.archivedAt) {
        throw new AppException(
          ERROR_CODES.PROJECT_ARCHIVED,
          'Archived projects cannot start new executions',
          HttpStatus.CONFLICT,
          {
            projectId: task.projectId,
            ...(projectState?.archivedAt
              ? { archivedAt: projectState.archivedAt.toISOString() }
              : {}),
          },
        );
      }

      let bindingSnapshot: {
        id: string;
        bindingVersion: number;
        validatedBindingVersion: number | null;
        status: string;
        canonicalPath: string | null;
        policyVersion: string | null;
        platform: string | null;
        validatedByRunnerId: string | null;
      } | null = null;
      if (requiresRunner) {
        if (!runnerComputerId) {
          throw new AppException(
            'COMPUTER_NOT_ASSIGNED',
            'Assign the agent to a computer with a connected runner',
            HttpStatus.CONFLICT,
          );
        }
        const currentBinding = await tx.projectRepositoryBinding.findUnique({
          where: {
            projectId_computerId: {
              projectId: task.projectId,
              computerId: runnerComputerId,
            },
          },
          select: {
            id: true,
            bindingVersion: true,
            validatedBindingVersion: true,
            status: true,
            canonicalPath: true,
            policyVersion: true,
            platform: true,
            validatedByRunnerId: true,
          },
        });
        if (!currentBinding) {
          throw bindingMissing(task.projectId, runnerComputerId);
        }
        if (
          !repositoryBinding ||
          currentBinding.id !== repositoryBinding.id ||
          currentBinding.bindingVersion !== repositoryBinding.bindingVersion ||
          !isReadyBinding(currentBinding)
        ) {
          throw bindingNotReady(currentBinding);
        }
        if (!runnerId) {
          throw new AppException(
            'RUNNER_OFFLINE',
            'No connected runner is available for this execution',
            HttpStatus.CONFLICT,
          );
        }
        assertBindingRunnerIdentity(currentBinding, runnerId, this.runtimes);
        bindingSnapshot = currentBinding;
      }

      const created = await tx.execution.create({
        data: {
          taskId,
          agentId: assigneeAgentId,
          runnerId,
          repositoryProjectId: requiresRunner ? task.projectId : null,
          repositoryBindingId: bindingSnapshot?.id ?? null,
          repositoryBindingVersion: bindingSnapshot?.bindingVersion ?? null,
          // Use the branch read in this transaction, never the possibly stale
          // value from the Task relation loaded before the precheck.
          repositoryDefaultBranch: requiresRunner ? projectState.defaultBranch : null,
          runtime: runtimeType,
          status: 'running',
          phase: requiresRunner ? 'queued' : 'running',
          progress: 0,
          progressMode: requiresRunner ? 'indeterminate' : 'determinate',
          dispatchState: requiresRunner ? 'created' : 'running',
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
      message: `${runtimeType} execution started`,
      taskId,
      agentId: assigneeAgentId,
      executionId: execution.id,
      status: 'running',
    });

    try {
      await this.runtimes.start(runtimeType, {
        executionId: execution.id,
        taskId,
        taskTitle: task.title,
        taskDescription: task.description,
        projectId: task.projectId,
        agentId: assigneeAgentId,
        agentName: executionDto.agent.name,
        runnerId,
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
      await this.runtimes.stop(runtimeType, execution.id).catch(() => undefined);
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
        error instanceof RepositoryDispatchError
          ? { code: error.code, retryable: error.retryable }
          : undefined,
      );
    }

    // Re-read after a successful dispatch so the response reflects the
    // post-handshake dispatch state and the prepared repository snapshot.
    return this.getExecutionDto(execution.id);
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

  /**
   * Returns the stored unified diff for an execution.
   *
   * The patch is read from a dedicated artifact row; no request parameter can
   * point at an arbitrary file or repository path. Large patches are never
   * embedded in execution list responses.
   */
  async diff(id: string): Promise<ExecutionDiffDto> {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      select: {
        id: true,
        branchName: true,
        baseCommit: true,
        headCommit: true,
        changedFiles: true,
        diffStat: true,
        gitStatus: true,
        diffTruncated: true,
      },
    });
    if (!execution) {
      throw new AppException('EXECUTION_NOT_FOUND', 'Execution not found', HttpStatus.NOT_FOUND);
    }
    const artifact = await this.prisma.executionArtifact.findUnique({
      where: { executionId_kind: { executionId: id, kind: 'git-diff' } },
      select: { content: true, byteSize: true, truncated: true, createdAt: true },
    });
    return toExecutionDiffDto(execution, artifact);
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
    const current = await this.prisma.execution.findUnique({
      where: { id },
      include: executionRelations,
    });
    if (!current) {
      throw new AppException('EXECUTION_NOT_FOUND', 'Execution not found', HttpStatus.NOT_FOUND);
    }
    if (current.status !== 'running') {
      throw new AppException(
        'EXECUTION_NOT_RUNNING',
        'Only a running execution can be cancelled',
        HttpStatus.CONFLICT,
      );
    }

    if (current.runtime === 'mock') {
      return this.withExecutionLock(id, () => this.cancelMockExecution(current, input));
    }
    return this.cancelRunnerExecution(current, input);
  }

  private async cancelMockExecution(
    execution: ExecutionWithRelations,
    input?: CancelExecutionInput,
  ): Promise<ExecutionDto> {
    const current = execution;
    if (current.status !== 'running') {
      throw new AppException(
        'EXECUTION_NOT_RUNNING',
        'Only a running execution can be cancelled',
        HttpStatus.CONFLICT,
      );
    }
    await this.runtimes.stop(current.runtime as AgentRuntimeType, current.id);
    const reason = input?.reason ?? 'Cancelled by operator';
    const endedAt = new Date();

    await this.prisma.$transaction([
      this.prisma.execution.update({
        where: { id: current.id },
        data: {
          status: 'cancelled',
          phase: 'cancelled',
          endedAt,
          cancelReason: reason,
          dispatchState: 'terminal',
        },
      }),
      this.prisma.task.update({
        where: { id: current.taskId },
        data: { status: 'cancelled' },
      }),
      this.prisma.agent.update({
        where: { id: current.agentId },
        data: { status: 'idle', lastActiveAt: endedAt },
      }),
    ]);

    await this.appendLog(current.id, 'warning', `Execution cancelled: ${reason}`);

    const [updatedExecution, taskDto, agentDto] = await Promise.all([
      this.getExecutionDto(current.id),
      this.getTaskDto(current.taskId),
      this.getAgentDto(current.agentId),
    ]);
    this.events.emitExecutionUpdated(updatedExecution);
    this.events.emitTaskUpdated(taskDto);
    this.events.emitAgentUpdated(agentDto);
    await this.activities.record({
      type: 'execution.cancelled',
      summary: `${updatedExecution.agent.name} stopped “${updatedExecution.task.title}”`,
      taskId: current.taskId,
      agentId: current.agentId,
      executionId: current.id,
      metadata: { reason },
    });
    this.logger.info({
      eventType: 'execution.cancelled',
      message: 'Execution cancelled by operator',
      taskId: current.taskId,
      agentId: current.agentId,
      executionId: current.id,
      status: 'cancelled',
    });
    return updatedExecution;
  }

  private async cancelRunnerExecution(
    execution: ExecutionWithRelations,
    input?: CancelExecutionInput,
  ): Promise<ExecutionDto> {
    const reason = input?.reason ?? 'Cancelled by operator';
    let dispatched = true;
    if (execution.runnerId) {
      dispatched = this.runtimes.cancelOnRunner(execution.runnerId, execution.id, reason);
    } else {
      await this.runtimes.stop(execution.runtime as AgentRuntimeType, execution.id);
    }
    if (!dispatched) {
      const latest = await this.findExecutionWithRelations(execution.id);
      if (latest && latest.status !== 'running') {
        return toExecutionDto(latest);
      }
      throw new AppException(
        'RUNNER_OFFLINE',
        'The runner is offline; the execution was not cancelled and remains running',
        HttpStatus.CONFLICT,
        { executionId: execution.id },
      );
    }

    // Real cancellation is only complete when the runner confirms that the
    // process tree stopped. Never assume success from the request alone.
    const terminal = await this.waitForExecutionTerminal(execution.id, RUNNER_CANCEL_TIMEOUT_MS);
    if (!terminal) {
      const latest = await this.findExecutionWithRelations(execution.id);
      if (latest && latest.status !== 'running') {
        return toExecutionDto(latest);
      }
      throw new AppException(
        'RUNNER_CANCEL_TIMEOUT',
        'The runner did not confirm that the process tree stopped; the execution remains running',
        HttpStatus.CONFLICT,
        { executionId: execution.id, timeoutMs: RUNNER_CANCEL_TIMEOUT_MS },
      );
    }
    return this.getExecutionDto(execution.id);
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
    const failureReason = formatStartFailureReason(input.error);
    const applied = await this.prisma.$transaction(async (tx) => {
      const current = await tx.execution.findUnique({
        where: { id: input.executionId },
        select: { status: true },
      });
      // Idempotent: a recovered failure or a duplicate caller may already have
      // made the row terminal. Never overwrite its reason or restore twice.
      if (!current || current.status !== 'running') {
        return false;
      }
      const updated = await tx.execution.updateMany({
        where: { id: input.executionId, status: 'running' },
        data: {
          status: 'failed',
          phase: 'failed',
          endedAt,
          failureReason,
          dispatchState: 'terminal',
        },
      });
      if (updated.count === 0) {
        return false;
      }
      await tx.task.update({
        where: { id: input.taskId },
        data: { status: input.previousTaskStatus },
      });
      await tx.agent.update({
        where: { id: input.agentId },
        data: {
          status: input.previousAgentStatus,
          lastActiveAt: input.previousAgentLastActiveAt,
        },
      });
      return true;
    });

    if (!applied) {
      this.logger.warn({
        eventType: 'runtime.start_rollback_skipped',
        message: 'Execution start failure was already handled by another path',
        taskId: input.taskId,
        agentId: input.agentId,
        executionId: input.executionId,
        status: 'warning',
      });
      return;
    }

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
      case 'phase':
        await this.handlePhase(event);
        break;
      case 'progress':
        await this.handleProgress(event);
        break;
      case 'completed':
        await this.finishExecution(event.executionId, 'completed', {
          exitCode: event.exitCode ?? null,
          summary: event.summary ?? null,
          git: event.git ?? null,
        });
        break;
      case 'failed':
        await this.finishExecution(event.executionId, 'failed', {
          reason: event.reason,
          exitCode: event.exitCode ?? null,
          summary: event.summary ?? null,
          git: event.git ?? null,
        });
        break;
      case 'cancelled':
        await this.finishExecution(event.executionId, 'cancelled', {
          reason: event.reason ?? 'Cancelled by operator',
          exitCode: event.exitCode ?? null,
          git: event.git ?? null,
        });
        break;
    }
  }

  private async handleLog(event: Extract<RuntimeEvent, { type: 'log' }>): Promise<void> {
    const execution = await this.prisma.execution.findUnique({
      where: { id: event.executionId },
      select: { id: true, status: true, runnerId: true },
    });
    if (!execution || execution.status !== 'running') {
      return;
    }
    // Runner sequence numbers are local to that execution on that runner.
    // Server-generated logs (phase messages, failures) also occupy `seq`, so
    // allocating a server sequence here prevents a runner log from being
    // mistaken for a duplicate of a server log. `runnerSeq` remains the
    // idempotency key for runner replays.
    const seq = event.runnerSeq ? await this.nextLogSeq(event.executionId) : event.seq;
    let log;
    try {
      log = await this.prisma.executionLog.create({
        data: {
          executionId: event.executionId,
          seq,
          stream: event.stream ?? 'system',
          eventId: event.eventId ?? null,
          runnerSeq: event.runnerSeq ?? null,
          level: event.level,
          message: event.message,
          ...(event.timestamp ? { timestamp: new Date(event.timestamp) } : {}),
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        if (execution.runnerId && event.runnerSeq) {
          this.runtimes.acknowledgeLog(execution.runnerId, event.executionId, event.runnerSeq);
        }
        return;
      }
      throw error;
    }

    if (event.runnerSeq) {
      await this.prisma.execution.updateMany({
        where: { id: event.executionId, lastRunnerSeq: { lt: event.runnerSeq } },
        data: { lastRunnerSeq: event.runnerSeq },
      });
    }
    this.events.emitExecutionLog(toExecutionLogDto(log));
    if (execution.runnerId && event.runnerSeq) {
      this.runtimes.acknowledgeLog(execution.runnerId, event.executionId, event.runnerSeq);
    }
  }

  private async handlePhase(event: Extract<RuntimeEvent, { type: 'phase' }>): Promise<void> {
    const result = await this.prisma.execution.updateMany({
      where: { id: event.executionId, status: 'running' },
      data: { phase: event.phase },
    });
    if (result.count === 0) {
      return;
    }
    if (event.message) {
      await this.appendLog(event.executionId, 'info', event.message);
    }
    const execution = await this.getExecutionDto(event.executionId);
    this.events.emitExecutionUpdated(execution);
  }

  private async handleProgress(event: Extract<RuntimeEvent, { type: 'progress' }>): Promise<void> {
    const result = await this.prisma.execution.updateMany({
      where: { id: event.executionId, status: 'running' },
      data: {
        progress: Math.min(100, Math.max(0, event.progress)),
        ...(event.progressMode ? { progressMode: event.progressMode } : {}),
      },
    });
    if (result.count === 0) {
      return;
    }
    const execution = await this.getExecutionDto(event.executionId);
    this.events.emitExecutionUpdated(execution);
  }

  private async finishExecution(
    id: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    metadata: {
      reason?: string | null;
      exitCode?: number | null;
      summary?: string | null;
      git?: {
        branchName: string;
        baseCommit: string;
        headCommit: string | null;
        changedFiles: number;
        diffStat: string;
        gitStatus: string;
        diff: string;
        diffTruncated: boolean;
      } | null;
    } = {},
  ): Promise<void> {
    const current = await this.prisma.execution.findUnique({
      where: { id },
      include: executionRelations,
    });
    if (!current || current.status !== 'running') {
      return;
    }
    const endedAt = new Date();
    const nextTaskStatus =
      outcome === 'completed' ? 'done' : outcome === 'failed' ? 'failed' : 'cancelled';
    const nextAgentStatus = outcome === 'failed' ? 'error' : 'idle';
    const git = metadata.git;
    const diff = git ? normalizeDiff(git.diff, git.diffTruncated) : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.execution.update({
        where: { id },
        data: {
          status: outcome,
          phase: outcome,
          progress: outcome === 'completed' ? 100 : current.progress,
          progressMode: outcome === 'completed' ? 'determinate' : current.progressMode,
          endedAt,
          dispatchState: 'terminal',
          ...(metadata.exitCode !== undefined ? { exitCode: metadata.exitCode } : {}),
          ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}),
          ...(outcome === 'failed' && metadata.reason ? { failureReason: metadata.reason } : {}),
          ...(outcome === 'cancelled'
            ? { cancelReason: metadata.reason ?? 'Cancelled by operator' }
            : {}),
          ...(git
            ? {
                branchName: git.branchName,
                baseCommit: git.baseCommit,
                headCommit: git.headCommit,
                changedFiles: git.changedFiles,
                diffStat: git.diffStat,
                gitStatus: git.gitStatus,
                diffTruncated: diff?.truncated ?? git.diffTruncated,
              }
            : {}),
        },
      });
      if (git && diff) {
        await tx.executionArtifact.upsert({
          where: { executionId_kind: { executionId: id, kind: 'git-diff' } },
          create: {
            executionId: id,
            kind: 'git-diff',
            content: diff.content,
            byteSize: Buffer.byteLength(diff.content, 'utf8'),
            truncated: diff.truncated,
          },
          update: {
            content: diff.content,
            byteSize: Buffer.byteLength(diff.content, 'utf8'),
            truncated: diff.truncated,
          },
        });
      }
      await tx.task.update({
        where: { id: current.taskId },
        data: { status: nextTaskStatus },
      });
      await tx.agent.update({
        where: { id: current.agentId },
        data: { status: nextAgentStatus, lastActiveAt: endedAt },
      });
    });

    this.runtimes.noteFinished(current.runtime as AgentRuntimeType, id);
    this.handshake.noteTerminal(id);

    if (outcome === 'failed' && metadata.reason) {
      const errorLog = await this.prisma.executionLog.findFirst({
        where: { executionId: id, level: 'error' },
        select: { id: true },
      });
      if (!errorLog) {
        await this.appendLog(id, 'error', `Execution failed: ${metadata.reason}`);
      }
    }
    if (outcome === 'cancelled') {
      await this.appendLog(
        id,
        'warning',
        `Execution cancelled: ${metadata.reason ?? 'Cancelled by operator'}`,
      );
    }

    const [executionDto, taskDto, agentDto] = await Promise.all([
      this.getExecutionDto(id),
      this.getTaskDto(current.taskId),
      this.getAgentDto(current.agentId),
    ]);
    this.events.emitExecutionUpdated(executionDto);
    this.events.emitTaskUpdated(taskDto);
    this.events.emitAgentUpdated(agentDto);

    await this.activities.record({
      type:
        outcome === 'completed'
          ? 'execution.completed'
          : outcome === 'failed'
            ? 'execution.failed'
            : 'execution.cancelled',
      summary:
        outcome === 'completed'
          ? `${executionDto.agent.name} completed “${executionDto.task.title}”`
          : outcome === 'failed'
            ? `${executionDto.agent.name} failed “${executionDto.task.title}”`
            : `${executionDto.agent.name} stopped “${executionDto.task.title}”`,
      taskId: current.taskId,
      agentId: current.agentId,
      executionId: id,
      metadata:
        outcome === 'failed'
          ? { failureReason: metadata.reason ?? null, exitCode: metadata.exitCode ?? null }
          : outcome === 'cancelled'
            ? { reason: metadata.reason ?? null }
            : null,
    });
    this.logger.info({
      eventType:
        outcome === 'completed'
          ? 'execution.completed'
          : outcome === 'failed'
            ? 'execution.failed'
            : 'execution.cancelled',
      message:
        outcome === 'completed'
          ? 'Execution completed successfully'
          : outcome === 'failed'
            ? 'Execution failed'
            : 'Execution cancelled',
      taskId: current.taskId,
      agentId: current.agentId,
      executionId: id,
      status: outcome,
      ...(metadata.reason ? { error: metadata.reason } : {}),
    });
  }

  private async appendLog(
    executionId: string,
    level: 'info' | 'success' | 'warning' | 'error',
    message: string,
    stream: 'stdout' | 'stderr' | 'system' = 'system',
  ): Promise<void> {
    const seq = await this.nextLogSeq(executionId);
    const log = await this.prisma.executionLog.create({
      data: { executionId, seq, level, message, stream },
    });
    this.events.emitExecutionLog(toExecutionLogDto(log));
  }

  private async nextLogSeq(executionId: string): Promise<number> {
    const aggregate = await this.prisma.executionLog.aggregate({
      where: { executionId },
      _max: { seq: true },
    });
    return (aggregate._max.seq ?? 0) + 1;
  }

  private async waitForExecutionTerminal(
    id: string,
    timeoutMs: number,
  ): Promise<{ status: string } | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const execution = await this.prisma.execution.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!execution) return null;
      if (execution.status !== 'running') return execution;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  private async findExecutionWithRelations(id: string) {
    return this.prisma.execution.findUnique({
      where: { id },
      include: executionRelations,
    });
  }

  private async getExecutionDto(id: string): Promise<ExecutionDto> {
    const execution = await this.findExecutionWithRelations(id);
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

interface BindingState {
  id: string;
  bindingVersion: number;
  validatedBindingVersion: number | null;
  status: string;
  canonicalPath: string | null;
  policyVersion: string | null;
  platform: string | null;
  validatedByRunnerId: string | null;
}

function isReadyBinding(binding: BindingState): boolean {
  return (
    binding.status === 'ready' &&
    binding.validatedBindingVersion === binding.bindingVersion &&
    Boolean(binding.canonicalPath) &&
    Boolean(binding.policyVersion) &&
    Boolean(binding.platform) &&
    Boolean(binding.validatedByRunnerId)
  );
}

/**
 * A ready binding is scoped to the Runner that validated it and to that
 * Runner's live platform. It never transfers to a replacement Runner.
 */
function assertBindingRunnerIdentity(
  binding: BindingState,
  runnerId: string,
  runtimes: RuntimeRegistryService,
): void {
  const live = runtimes.getLiveRunnerRegistration(runnerId);
  if (!live) {
    throw new AppException(
      ERROR_CODES.RUNNER_OFFLINE,
      'The assigned runner is no longer connected',
      HttpStatus.CONFLICT,
      { runnerId },
    );
  }
  if (
    binding.validatedByRunnerId !== runnerId ||
    !binding.platform ||
    binding.platform !== live.platform
  ) {
    throw new AppException(
      ERROR_CODES.PROJECT_BINDING_NOT_READY,
      'The repository binding must be validated on the selected runner and platform',
      HttpStatus.CONFLICT,
      {
        bindingId: binding.id,
        bindingVersion: binding.bindingVersion,
        validatedByRunnerId: binding.validatedByRunnerId,
        bindingPlatform: binding.platform,
        selectedRunnerId: runnerId,
        selectedRunnerPlatform: live.platform,
      },
    );
  }
}

function formatStartFailureReason(error: unknown): string {
  if (error instanceof RepositoryDispatchError) {
    // The error may already carry the code prefix (for example a message
    // forwarded verbatim from the Runner). Never render it twice.
    const prefix = `${error.code}: `;
    const message = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    return `${error.code}: ${message}`.slice(0, 2000);
  }
  return 'The runtime failed to start this execution';
}

function bindingMissing(projectId: string, computerId: string): AppException {
  return new AppException(
    ERROR_CODES.PROJECT_BINDING_MISSING,
    'This project has no repository binding for the assigned computer',
    HttpStatus.CONFLICT,
    { projectId, computerId },
  );
}

function bindingNotReady(binding: BindingState): AppException {
  return new AppException(
    ERROR_CODES.PROJECT_BINDING_NOT_READY,
    'The repository binding must be validated before a real execution can start',
    HttpStatus.CONFLICT,
    {
      bindingId: binding.id,
      bindingStatus: binding.status,
      bindingVersion: binding.bindingVersion,
      validatedBindingVersion: binding.validatedBindingVersion,
    },
  );
}

function runtimeUnavailable(
  reasonCode: string | null,
  reason: string | null,
  runtime: AgentRuntimeType,
): AppException {
  const conflictCodes = new Set([
    'COMPUTER_NOT_ASSIGNED',
    'RUNNER_NOT_REGISTERED',
    'RUNNER_OFFLINE',
    'COMPUTER_OFFLINE',
    'PROJECT_BINDING_UNSUPPORTED',
    'PROJECT_BINDING_NOT_READY',
  ]);
  const code = reasonCode ?? 'RUNTIME_NOT_AVAILABLE';
  return new AppException(
    code,
    reason ?? `${runtime} runtime is not available`,
    conflictCodes.has(code) ? HttpStatus.CONFLICT : HttpStatus.UNPROCESSABLE_ENTITY,
    { runtime, reasonCode: code },
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002',
  );
}

function normalizeDiff(
  raw: string | null | undefined,
  truncated: boolean,
): { content: string; truncated: boolean } {
  const value = raw ?? '';
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= EXECUTION_DIFF_MAX_BYTES) {
    return { content: value, truncated };
  }
  const buffer = Buffer.from(value, 'utf8').subarray(0, EXECUTION_DIFF_MAX_BYTES);
  let content = buffer.toString('utf8');
  // A byte cut can split a multi-byte sequence and decoding inserts U+FFFD,
  // which is 3 bytes again. Remove whole code points until the stored value is
  // genuinely within the byte cap.
  while (Buffer.byteLength(content, 'utf8') > EXECUTION_DIFF_MAX_BYTES) {
    content = content.slice(0, -1);
  }
  return { content, truncated: true };
}
