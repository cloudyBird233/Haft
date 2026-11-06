import { HttpStatus, Injectable } from '@nestjs/common';
import type { DashboardDto, WorkspaceDto } from '@raft-lite/contracts';
import { DEFAULT_WORKSPACE_ID } from '../../common/constants';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  activityRelations,
  agentRelations,
  taskRelations,
  toActivityDto,
  toAgentDto,
  toTaskDto,
  toWorkspaceDto,
} from '../../common/serializers';

@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  async getWorkspace(): Promise<WorkspaceDto> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: DEFAULT_WORKSPACE_ID },
      include: { projects: { orderBy: { createdAt: 'asc' } } },
    });
    if (!workspace) {
      throw new AppException(
        'WORKSPACE_NOT_FOUND',
        'Default workspace has not been initialized',
        HttpStatus.NOT_FOUND,
      );
    }
    return toWorkspaceDto(workspace);
  }

  async getDashboard(): Promise<DashboardDto> {
    const workspace = await this.getWorkspace();
    const [
      agents,
      recentTasks,
      recentActivities,
      agentsTotal,
      agentsOffline,
      tasksRunning,
      tasksCompleted,
      tasksTotal,
    ] = await this.prisma.$transaction([
      this.prisma.agent.findMany({
        where: { workspaceId: DEFAULT_WORKSPACE_ID },
        include: agentRelations,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.task.findMany({
        where: { workspaceId: DEFAULT_WORKSPACE_ID },
        include: taskRelations,
        orderBy: { updatedAt: 'desc' },
        take: 6,
      }),
      this.prisma.activity.findMany({
        where: { workspaceId: DEFAULT_WORKSPACE_ID },
        include: activityRelations,
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.agent.count({ where: { workspaceId: DEFAULT_WORKSPACE_ID } }),
      this.prisma.agent.count({
        where: { workspaceId: DEFAULT_WORKSPACE_ID, status: 'offline' },
      }),
      this.prisma.task.count({
        where: { workspaceId: DEFAULT_WORKSPACE_ID, status: 'in_progress' },
      }),
      this.prisma.task.count({
        where: { workspaceId: DEFAULT_WORKSPACE_ID, status: 'done' },
      }),
      this.prisma.task.count({ where: { workspaceId: DEFAULT_WORKSPACE_ID } }),
    ]);

    return {
      workspace,
      metrics: {
        agentsTotal,
        agentsOnline: agentsTotal - agentsOffline,
        tasksRunning,
        tasksCompleted,
        tasksTotal,
      },
      recentTasks: recentTasks.map(toTaskDto),
      recentActivities: recentActivities.map(toActivityDto),
      agents: agents.map(toAgentDto),
      projects: workspace.projects,
    };
  }
}
