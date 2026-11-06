import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AgentDetailDto,
  AgentDto,
  AgentListQuery,
  AgentStatus,
  CreateAgentInput,
  ListDto,
  UpdateAgentInput,
} from '@raft-lite/contracts';
import { DEFAULT_WORKSPACE_ID } from '../../common/constants';
import { AppException } from '../../common/errors/app.exception';
import { AppLogger } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  agentRelations,
  executionRelations,
  taskRelations,
  taskSummaryRelations,
  toAgentDetailDto,
  toAgentDto,
  toTaskDto,
} from '../../common/serializers';
import { ActivitiesService } from '../activities/activities.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly events: EventsGateway,
    private readonly logger: AppLogger,
  ) {}

  async list(query: AgentListQuery): Promise<ListDto<AgentDto>> {
    const where = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { role: { contains: query.search } },
              { description: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.agent.findMany({
        where,
        include: agentRelations,
        orderBy: { createdAt: 'asc' },
        skip: query.offset ?? 0,
        take: query.limit ?? 50,
      }),
      this.prisma.agent.count({ where }),
    ]);
    return { items: records.map(toAgentDto), total };
  }

  async findOne(id: string): Promise<AgentDetailDto> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: agentRelations,
    });
    if (!agent) {
      throw new AppException('AGENT_NOT_FOUND', 'Agent not found', HttpStatus.NOT_FOUND);
    }

    const [currentTask, recentExecutions] = await this.prisma.$transaction([
      this.prisma.task.findFirst({
        where: {
          assigneeAgentId: id,
          status: { in: ['claimed', 'in_progress', 'in_review'] },
        },
        include: taskSummaryRelations,
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.execution.findMany({
        where: { agentId: id },
        include: executionRelations,
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    return toAgentDetailDto(agent, currentTask, recentExecutions);
  }

  async create(input: CreateAgentInput): Promise<AgentDto> {
    if (input.computerId) {
      await this.assertComputer(input.computerId);
    }
    const agent = await this.prisma.agent.create({
      data: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: input.name,
        role: input.role,
        description: input.description,
        runtime: input.runtime,
        computerId: input.computerId,
      },
      include: agentRelations,
    });
    const dto = toAgentDto(agent);
    await this.activities.record({
      type: 'agent.created',
      summary: `Added ${agent.name} to the workspace`,
      agentId: agent.id,
    });
    this.events.emitAgentUpdated(dto);
    this.logger.info({
      eventType: 'agent.created',
      message: `Agent ${agent.name} created`,
      agentId: agent.id,
      status: agent.status,
    });
    return dto;
  }

  async update(id: string, input: UpdateAgentInput): Promise<AgentDto> {
    const existing = await this.prisma.agent.findUnique({ where: { id } });
    if (!existing) {
      throw new AppException('AGENT_NOT_FOUND', 'Agent not found', HttpStatus.NOT_FOUND);
    }
    if (input.computerId) {
      await this.assertComputer(input.computerId);
    }
    if (input.status === 'busy') {
      throw new AppException(
        'AGENT_STATUS_MANAGED',
        'Busy status is managed by executions and cannot be set manually',
        HttpStatus.CONFLICT,
      );
    }

    const activeExecution = await this.prisma.execution.findFirst({
      where: { agentId: id, status: 'running' },
      select: { id: true },
    });
    if (activeExecution && input.status) {
      throw new AppException(
        'AGENT_BUSY',
        'Agent status cannot be changed while an execution is running',
        HttpStatus.CONFLICT,
      );
    }

    const agent = await this.prisma.agent.update({
      where: { id },
      data: {
        ...input,
        ...(input.status ? { lastActiveAt: new Date() } : {}),
      },
      include: agentRelations,
    });
    const dto = toAgentDto(agent);
    await this.activities.record({
      type: 'agent.updated',
      summary: `Updated ${agent.name}`,
      agentId: agent.id,
    });
    this.events.emitAgentUpdated(dto);
    this.logger.info({
      eventType: 'agent.updated',
      message: `Agent ${agent.name} updated`,
      agentId: agent.id,
      status: agent.status,
    });
    return dto;
  }

  async remove(id: string): Promise<{ id: string }> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new AppException('AGENT_NOT_FOUND', 'Agent not found', HttpStatus.NOT_FOUND);
    }
    const activeExecution = await this.prisma.execution.findFirst({
      where: { agentId: id, status: 'running' },
      select: { id: true },
    });
    if (activeExecution) {
      throw new AppException(
        'AGENT_BUSY',
        'Stop the active execution before deleting this agent',
        HttpStatus.CONFLICT,
      );
    }

    const affectedTaskIds = await this.prisma.$transaction(async (tx) => {
      const affectedTasks = await tx.task.findMany({
        where: {
          assigneeAgentId: id,
          status: { in: ['claimed', 'in_progress', 'in_review'] },
        },
        select: { id: true },
      });
      if (affectedTasks.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: affectedTasks.map((task) => task.id) } },
          data: { assigneeAgentId: null, status: 'todo' },
        });
      }
      await tx.agent.delete({ where: { id } });
      return affectedTasks.map((task) => task.id);
    });

    const updatedTasks =
      affectedTaskIds.length > 0
        ? await this.prisma.task.findMany({
            where: { id: { in: affectedTaskIds } },
            include: taskRelations,
          })
        : [];

    await this.activities.record({
      type: 'agent.deleted',
      summary:
        affectedTaskIds.length > 0
          ? `Removed ${agent.name} from the workspace and unassigned ${affectedTaskIds.length} task${affectedTaskIds.length === 1 ? '' : 's'}`
          : `Removed ${agent.name} from the workspace`,
      agentId: null,
      metadata: affectedTaskIds.length > 0 ? { taskIds: affectedTaskIds } : null,
    });
    this.events.emitAgentRemoved(id);
    for (const task of updatedTasks) {
      this.events.emitTaskUpdated(toTaskDto(task));
    }
    this.logger.info({
      eventType: 'agent.deleted',
      message: `Agent ${agent.name} deleted`,
      agentId: id,
      status: 'deleted',
    });
    return { id };
  }

  private async assertComputer(computerId: string): Promise<void> {
    const computer = await this.prisma.computer.findUnique({ where: { id: computerId } });
    if (!computer) {
      throw new AppException(
        'COMPUTER_NOT_FOUND',
        'Selected computer does not exist',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}

export type { AgentStatus };
