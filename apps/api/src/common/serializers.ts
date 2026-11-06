import type { Prisma } from '@prisma/client';
import type {
  ActivityDto,
  AgentDetailDto,
  AgentDto,
  AgentSummaryDto,
  ComputerDto,
  ExecutionDto,
  ExecutionLogDto,
  ExecutionSummaryDto,
  ProjectDto,
  TaskDetailDto,
  TaskDto,
  TaskSummaryDto,
  WorkspaceDto,
} from '@raft-lite/contracts';
import type {
  ActivityType,
  AgentRuntimeType,
  AgentStatus,
  ExecutionStatus,
  LogLevel,
  TaskPriority,
  TaskStatus,
} from '@raft-lite/contracts';

export const agentRelations = {
  computer: true,
} satisfies Prisma.AgentInclude;
export type AgentWithRelations = Prisma.AgentGetPayload<{ include: typeof agentRelations }>;

export const taskSummaryRelations = {
  project: true,
  assignee: { include: { computer: true } },
} satisfies Prisma.TaskInclude;
export type TaskSummaryRecord = Prisma.TaskGetPayload<{ include: typeof taskSummaryRelations }>;

export const taskRelations = {
  ...taskSummaryRelations,
  executions: { orderBy: { createdAt: 'desc' }, take: 1 },
} satisfies Prisma.TaskInclude;
export type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof taskRelations }>;

export const taskDetailRelations = {
  ...taskSummaryRelations,
  executions: { orderBy: { createdAt: 'desc' }, take: 20 },
} satisfies Prisma.TaskInclude;
export type TaskDetailRecord = Prisma.TaskGetPayload<{ include: typeof taskDetailRelations }>;

export const executionRelations = {
  task: { include: taskSummaryRelations },
  agent: { include: agentRelations },
} satisfies Prisma.ExecutionInclude;
export type ExecutionWithRelations = Prisma.ExecutionGetPayload<{
  include: typeof executionRelations;
}>;

export const activityRelations = {
  agent: { select: { id: true, name: true } },
  task: { select: { id: true, title: true } },
} satisfies Prisma.ActivityInclude;
export type ActivityWithRelations = Prisma.ActivityGetPayload<{
  include: typeof activityRelations;
}>;

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? iso(value) : null);
const asEnum = <T extends string>(value: string): T => value as T;

export function toComputerDto(computer: Prisma.ComputerGetPayload<object>): ComputerDto {
  return {
    id: computer.id,
    name: computer.name,
    hostname: computer.hostname,
    status: computer.status === 'offline' ? 'offline' : 'online',
    lastSeenAt: isoOrNull(computer.lastSeenAt),
    createdAt: iso(computer.createdAt),
  };
}

export function toProjectDto(project: Prisma.ProjectGetPayload<object>): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    key: project.key,
    description: project.description,
    color: project.color,
    createdAt: iso(project.createdAt),
  };
}

export function toAgentSummaryDto(agent: {
  id: string;
  name: string;
  role: string;
  status: string;
  runtime: string;
}): AgentSummaryDto {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: asEnum<AgentStatus>(agent.status),
    runtime: asEnum<AgentRuntimeType>(agent.runtime),
  };
}

export function toAgentDto(agent: AgentWithRelations): AgentDto {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    runtime: asEnum<AgentRuntimeType>(agent.runtime),
    status: asEnum<AgentStatus>(agent.status),
    computerId: agent.computerId,
    computer: agent.computer ? toComputerDto(agent.computer) : null,
    createdAt: iso(agent.createdAt),
    updatedAt: iso(agent.updatedAt),
    lastActiveAt: isoOrNull(agent.lastActiveAt),
  };
}

export function toExecutionSummaryDto(execution: {
  id: string;
  taskId: string;
  agentId: string;
  runtime: string;
  status: string;
  progress: number;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
}): ExecutionSummaryDto {
  return {
    id: execution.id,
    taskId: execution.taskId,
    agentId: execution.agentId,
    runtime: execution.runtime,
    status: asEnum<ExecutionStatus>(execution.status),
    progress: execution.progress,
    startedAt: iso(execution.startedAt),
    endedAt: isoOrNull(execution.endedAt),
    createdAt: iso(execution.createdAt),
  };
}

export function toTaskSummaryDto(task: TaskSummaryRecord): TaskSummaryDto {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: asEnum<TaskStatus>(task.status),
    priority: asEnum<TaskPriority>(task.priority),
    projectId: task.projectId,
    projectName: task.project.name,
    projectKey: task.project.key,
    assignee: task.assignee ? toAgentSummaryDto(task.assignee) : null,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  };
}

export function toTaskDto(task: TaskWithRelations): TaskDto {
  const latest = task.executions[0];
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    projectId: task.projectId,
    project: toProjectDto(task.project),
    assignee: task.assignee ? toAgentSummaryDto(task.assignee) : null,
    priority: asEnum<TaskPriority>(task.priority),
    status: asEnum<TaskStatus>(task.status),
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
    latestExecution: latest ? toExecutionSummaryDto(latest) : null,
  };
}

export function toTaskDetailDto(task: TaskDetailRecord, executionCount: number): TaskDetailDto {
  const latest = task.executions[0];
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    projectId: task.projectId,
    project: toProjectDto(task.project),
    assignee: task.assignee ? toAgentSummaryDto(task.assignee) : null,
    priority: asEnum<TaskPriority>(task.priority),
    status: asEnum<TaskStatus>(task.status),
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
    latestExecution: latest ? toExecutionSummaryDto(latest) : null,
    executionCount,
    executions: task.executions.map(toExecutionSummaryDto),
  };
}

export function toExecutionDto(execution: ExecutionWithRelations): ExecutionDto {
  return {
    id: execution.id,
    taskId: execution.taskId,
    agentId: execution.agentId,
    runtime: execution.runtime,
    status: asEnum<ExecutionStatus>(execution.status),
    progress: execution.progress,
    startedAt: iso(execution.startedAt),
    endedAt: isoOrNull(execution.endedAt),
    failureReason: execution.failureReason,
    cancelReason: execution.cancelReason,
    createdAt: iso(execution.createdAt),
    updatedAt: iso(execution.updatedAt),
    task: toTaskSummaryDto(execution.task),
    agent: toAgentSummaryDto(execution.agent),
  };
}

export function toExecutionLogDto(log: Prisma.ExecutionLogGetPayload<object>): ExecutionLogDto {
  return {
    id: log.id,
    executionId: log.executionId,
    seq: log.seq,
    level: asEnum<LogLevel>(log.level),
    message: log.message,
    timestamp: iso(log.timestamp),
  };
}

export function toAgentDetailDto(
  agent: AgentWithRelations,
  currentTask: TaskSummaryRecord | null,
  recentExecutions: ExecutionWithRelations[],
): AgentDetailDto {
  return {
    ...toAgentDto(agent),
    currentTask: currentTask ? toTaskSummaryDto(currentTask) : null,
    recentExecutions: recentExecutions.map(toExecutionDto),
  };
}

export function toActivityDto(activity: ActivityWithRelations): ActivityDto {
  let metadata: Record<string, unknown> | null = null;
  if (activity.metadata) {
    try {
      const parsed: unknown = JSON.parse(activity.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = null;
    }
  }
  return {
    id: activity.id,
    type: asEnum<ActivityType>(activity.type),
    summary: activity.summary,
    taskId: activity.taskId,
    agentId: activity.agentId,
    executionId: activity.executionId,
    metadata,
    createdAt: iso(activity.createdAt),
    agent: activity.agent,
    task: activity.task,
  };
}

export function toWorkspaceDto(
  workspace: Prisma.WorkspaceGetPayload<{ include: { projects: true } }>,
): WorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    createdAt: iso(workspace.createdAt),
    projects: workspace.projects.map(toProjectDto),
  };
}
