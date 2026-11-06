import type {
  ActivityType,
  AgentRuntimeType,
  AgentStatus,
  ExecutionStatus,
  LogLevel,
  TaskPriority,
  TaskStatus,
} from './constants';

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[] | Record<string, unknown> | null;
  };
  requestId: string;
}

export interface ListDto<T> {
  items: T[];
  total: number;
}

export interface ComputerDto {
  id: string;
  name: string;
  hostname: string;
  status: 'online' | 'offline';
  lastSeenAt: string | null;
  createdAt: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  key: string;
  description: string;
  color: string;
  createdAt: string;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  projects: ProjectDto[];
}

export interface AgentSummaryDto {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  runtime: AgentRuntimeType;
}

export interface AgentDto {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  description: string;
  runtime: AgentRuntimeType;
  status: AgentStatus;
  computerId: string | null;
  computer: ComputerDto | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
}

export interface TaskSummaryDto {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  projectName: string;
  projectKey: string;
  assignee: AgentSummaryDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionSummaryDto {
  id: string;
  taskId: string;
  agentId: string;
  runtime: string;
  status: ExecutionStatus;
  progress: number;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
}

export interface TaskDto {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  projectId: string;
  project: ProjectDto;
  assignee: AgentSummaryDto | null;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  latestExecution: ExecutionSummaryDto | null;
}

export interface TaskDetailDto extends TaskDto {
  executionCount: number;
  executions: ExecutionSummaryDto[];
}

export interface TaskCancellationDto {
  task: TaskDto;
  execution: ExecutionDto | null;
}

export interface ExecutionDto {
  id: string;
  taskId: string;
  agentId: string;
  runtime: string;
  status: ExecutionStatus;
  progress: number;
  startedAt: string;
  endedAt: string | null;
  failureReason: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  task: TaskSummaryDto;
  agent: AgentSummaryDto;
}

export interface ExecutionLogDto {
  id: string;
  executionId: string;
  seq: number;
  level: LogLevel;
  message: string;
  timestamp: string;
}

export interface AgentDetailDto extends AgentDto {
  currentTask: TaskSummaryDto | null;
  recentExecutions: ExecutionDto[];
}

export interface ActivityDto {
  id: string;
  type: ActivityType;
  summary: string;
  taskId: string | null;
  agentId: string | null;
  executionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  agent: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
}

export interface DashboardMetrics {
  agentsTotal: number;
  agentsOnline: number;
  tasksRunning: number;
  tasksCompleted: number;
  tasksTotal: number;
}

export interface DashboardDto {
  workspace: WorkspaceDto;
  metrics: DashboardMetrics;
  recentTasks: TaskDto[];
  recentActivities: ActivityDto[];
  agents: AgentDto[];
  projects: ProjectDto[];
}

export interface HealthDto {
  status: 'ok';
  database: 'up';
  testMode: boolean;
  timestamp: string;
  version: string;
}

export type TestSeedPreset = 'default' | 'empty';
export type RuntimeControlMode = 'auto' | 'manual';
export type RuntimeFinishOutcome = 'success' | 'failure';

export interface TestResetResult {
  preset: TestSeedPreset;
  seededAt: string;
}

export interface RuntimeModeResult {
  mode: RuntimeControlMode;
}

export interface AdvanceExecutionResult {
  executionId: string;
  step: number;
  progress: number;
  completed: boolean;
}

export interface FinishExecutionResult {
  executionId: string;
  outcome: RuntimeFinishOutcome;
  emitted: boolean;
}
