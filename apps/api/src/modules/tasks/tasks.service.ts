import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AssignTaskInput,
  CreateTaskInput,
  ListDto,
  TaskDetailDto,
  TaskDto,
  TaskListQuery,
  UpdateTaskInput,
} from '@raft-lite/contracts';
import { canTransitionTask, TASK_STATUS_LABELS } from '@raft-lite/contracts';
import type { Prisma } from '@prisma/client';
import { DEFAULT_WORKSPACE_ID } from '../../common/constants';
import { AppException } from '../../common/errors/app.exception';
import { AppLogger } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  taskDetailRelations,
  taskRelations,
  toTaskDetailDto,
  toTaskDto,
} from '../../common/serializers';
import { ActivitiesService } from '../activities/activities.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly events: EventsGateway,
    private readonly logger: AppLogger,
  ) {}

  async list(query: TaskListQuery): Promise<ListDto<TaskDto>> {
    const where: Prisma.TaskWhereInput = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.assigneeAgentId === 'unassigned'
        ? { assigneeAgentId: null }
        : query.assigneeAgentId
          ? { assigneeAgentId: query.assigneeAgentId }
          : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search } },
              { description: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        include: taskRelations,
        orderBy: { updatedAt: 'desc' },
        skip: query.offset ?? 0,
        take: query.limit ?? 100,
      }),
      this.prisma.task.count({ where }),
    ]);
    return { items: records.map(toTaskDto), total };
  }

  async findOne(id: string): Promise<TaskDetailDto> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: taskDetailRelations,
    });
    if (!task) {
      throw new AppException('TASK_NOT_FOUND', 'Task not found', HttpStatus.NOT_FOUND);
    }
    const executionCount = await this.prisma.execution.count({ where: { taskId: id } });
    return toTaskDetailDto(task, executionCount);
  }

  async create(input: CreateTaskInput): Promise<TaskDto> {
    // Fast precheck for a friendly error. The authoritative check runs again
    // inside the same transaction that inserts the Task, so a concurrent
    // archive between these two steps cannot create a task in an archived
    // project.
    await this.assertProject(input.projectId);
    if (input.assigneeAgentId) {
      await this.assertAgent(input.assigneeAgentId);
    }

    const task = await this.prisma.$transaction(async (tx) => {
      await this.assertProject(input.projectId, tx);
      return tx.task.create({
        data: {
          workspaceId: DEFAULT_WORKSPACE_ID,
          projectId: input.projectId,
          assigneeAgentId: input.assigneeAgentId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          status: input.assigneeAgentId ? 'claimed' : 'todo',
        },
        include: taskRelations,
      });
    });
    const dto = toTaskDto(task);
    await this.activities.record({
      type: 'task.created',
      summary: `Created “${task.title}”`,
      taskId: task.id,
      agentId: task.assigneeAgentId,
    });
    if (task.assigneeAgentId) {
      await this.activities.record({
        type: 'task.assigned',
        summary: `${task.assignee?.name ?? 'An agent'} was assigned “${task.title}”`,
        taskId: task.id,
        agentId: task.assigneeAgentId,
      });
    }
    this.events.emitTaskUpdated(dto);
    this.logger.info({
      eventType: 'task.created',
      message: `Task ${task.title} created`,
      taskId: task.id,
      agentId: task.assigneeAgentId ?? undefined,
      status: task.status,
    });
    return dto;
  }

  async update(id: string, input: UpdateTaskInput): Promise<TaskDto> {
    const existing = await this.prisma.task.findUnique({
      where: { id },
      include: taskRelations,
    });
    if (!existing) {
      throw new AppException('TASK_NOT_FOUND', 'Task not found', HttpStatus.NOT_FOUND);
    }
    const targetProjectId =
      input.projectId && input.projectId !== existing.projectId ? input.projectId : null;
    if (targetProjectId) {
      await this.assertProject(targetProjectId);
    }
    if (input.status && input.status !== existing.status) {
      const activeExecution = await this.prisma.execution.findFirst({
        where: { taskId: id, status: 'running' },
        select: { id: true },
      });
      if (activeExecution) {
        throw new AppException(
          'TASK_EXECUTION_ACTIVE',
          'Task status is managed by the active execution',
          HttpStatus.CONFLICT,
        );
      }
      if (!canTransitionTask(existing.status as never, input.status as never)) {
        throw new AppException(
          'INVALID_TASK_TRANSITION',
          `Cannot move a task from ${TASK_STATUS_LABELS[existing.status as keyof typeof TASK_STATUS_LABELS]} to ${TASK_STATUS_LABELS[input.status]}`,
          HttpStatus.CONFLICT,
          {
            from: existing.status,
            to: input.status,
          },
        );
      }
    }

    const task = await this.prisma.$transaction(async (tx) => {
      // Moving a Task to another Project is also a write against that Project.
      // Re-read it in the write transaction so a concurrent archive cannot be
      // bypassed by the precheck above.
      if (targetProjectId) {
        await this.assertProject(targetProjectId, tx);
      }
      return tx.task.update({
        where: { id },
        data: input,
        include: taskRelations,
      });
    });
    const dto = toTaskDto(task);
    const changedStatus = input.status && input.status !== existing.status;
    await this.activities.record({
      type: changedStatus ? 'task.status_changed' : 'task.updated',
      summary: changedStatus
        ? `Moved “${task.title}” to ${TASK_STATUS_LABELS[task.status as keyof typeof TASK_STATUS_LABELS]}`
        : `Updated “${task.title}”`,
      taskId: task.id,
      agentId: task.assigneeAgentId,
      metadata: changedStatus ? { from: existing.status, to: task.status } : null,
    });
    this.events.emitTaskUpdated(dto);
    this.logger.info({
      eventType: changedStatus ? 'task.status_changed' : 'task.updated',
      message: `Task ${task.title} updated`,
      taskId: task.id,
      agentId: task.assigneeAgentId ?? undefined,
      status: task.status,
    });
    return dto;
  }

  async assign(id: string, input: AssignTaskInput): Promise<TaskDto> {
    const existing = await this.prisma.task.findUnique({
      where: { id },
      include: taskRelations,
    });
    if (!existing) {
      throw new AppException('TASK_NOT_FOUND', 'Task not found', HttpStatus.NOT_FOUND);
    }
    const activeExecution = await this.prisma.execution.findFirst({
      where: { taskId: id, status: 'running' },
      select: { id: true },
    });
    if (activeExecution) {
      throw new AppException(
        'TASK_EXECUTION_ACTIVE',
        'Cannot reassign a task while its execution is running',
        HttpStatus.CONFLICT,
      );
    }
    if (['done', 'cancelled'].includes(existing.status)) {
      throw new AppException(
        'TASK_TERMINAL',
        'Completed or cancelled tasks cannot be assigned',
        HttpStatus.CONFLICT,
      );
    }

    let agentName: string | null = null;
    if (input.agentId) {
      const agent = await this.assertAgent(input.agentId);
      agentName = agent.name;
    }

    let nextStatus = existing.status;
    if (input.agentId && existing.status === 'todo') {
      nextStatus = 'claimed';
    } else if (!input.agentId && existing.status === 'claimed') {
      nextStatus = 'todo';
    }

    const task = await this.prisma.task.update({
      where: { id },
      data: {
        assigneeAgentId: input.agentId,
        status: nextStatus,
      },
      include: taskRelations,
    });
    const dto = toTaskDto(task);
    await this.activities.record({
      type: 'task.assigned',
      summary: input.agentId
        ? `${agentName ?? 'An agent'} was assigned “${task.title}”`
        : `“${task.title}” was unassigned`,
      taskId: task.id,
      agentId: task.assigneeAgentId,
    });
    this.events.emitTaskUpdated(dto);
    this.logger.info({
      eventType: 'task.assigned',
      message: `Task ${task.title} assignment changed`,
      taskId: task.id,
      agentId: task.assigneeAgentId ?? undefined,
      status: task.status,
    });
    return dto;
  }

  async remove(id: string): Promise<{ id: string }> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new AppException('TASK_NOT_FOUND', 'Task not found', HttpStatus.NOT_FOUND);
    }
    const activeExecution = await this.prisma.execution.findFirst({
      where: { taskId: id, status: 'running' },
      select: { id: true },
    });
    if (activeExecution) {
      throw new AppException(
        'TASK_EXECUTION_ACTIVE',
        'Cancel the running execution before deleting this task',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.task.delete({ where: { id } });
    await this.activities.record({
      type: 'task.deleted',
      summary: `Deleted “${task.title}”`,
    });
    this.events.emitTaskRemoved(id);
    this.logger.info({
      eventType: 'task.deleted',
      message: `Task ${task.title} deleted`,
      taskId: id,
      status: 'deleted',
    });
    return { id };
  }

  private async assertProject(
    projectId: string,
    client: Pick<Prisma.TransactionClient, 'project'> = this.prisma,
  ): Promise<void> {
    const project = await client.project.findFirst({
      where: { id: projectId, workspaceId: DEFAULT_WORKSPACE_ID },
    });
    if (!project) {
      throw new AppException(
        'PROJECT_NOT_FOUND',
        'Selected project does not exist',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (project.archivedAt) {
      throw new AppException(
        'PROJECT_ARCHIVED',
        'Archived projects cannot receive new tasks',
        HttpStatus.CONFLICT,
        { projectId: project.id, archivedAt: project.archivedAt.toISOString() },
      );
    }
  }

  private async assertAgent(agentId: string): Promise<{ id: string; name: string }> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, workspaceId: DEFAULT_WORKSPACE_ID },
      select: { id: true, name: true },
    });
    if (!agent) {
      throw new AppException(
        'AGENT_NOT_FOUND',
        'Selected agent does not exist',
        HttpStatus.BAD_REQUEST,
      );
    }
    return agent;
  }
}
