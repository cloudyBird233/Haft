import type {
  ActivityType,
  AgentRuntimeType,
  AgentStatus,
  ExecutionPhase,
  ExecutionStatus,
  LogLevel,
  LogStream,
  ProgressMode,
  ProjectBindingStatus,
  RunnerFeature,
  RunnerStatus,
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

export interface RunnerRuntimeCapabilityDto {
  runtime: AgentRuntimeType;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  message: string | null;
}

export interface RunnerCapabilitiesDto {
  runtimes: RunnerRuntimeCapabilityDto[];
  projectIds: string[];
  maxConcurrentExecutions: number | null;
  features: RunnerFeature[];
}

export interface RunnerSummaryDto {
  id: string;
  computerId: string;
  status: RunnerStatus;
  runnerVersion: string;
  platform: string;
  architecture: string;
  lastHeartbeatAt: string | null;
}

export interface RunnerDto extends RunnerSummaryDto {
  protocolVersion: number;
  capabilities: RunnerCapabilitiesDto;
  maxConcurrentExecutions: number;
  connectedAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  computer: ComputerDto | null;
}

export interface RuntimeAvailabilityDto {
  runtime: AgentRuntimeType;
  label: string;
  available: boolean;
  requiresRunner: boolean;
  reason: string | null;
  reasonCode: string | null;
  runnerId: string | null;
  runnerStatus: RunnerStatus | null;
  cliVersion: string | null;
  authenticated: boolean | null;
  projectIds: string[];
}

export interface ProjectDto {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  description: string;
  color: string;
  defaultBranch: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on project list/detail responses; omitted in nested task summaries. */
  taskCount?: number;
  executionCount?: number;
  bindingCount?: number;
}

export interface ProjectBindingDto {
  id: string;
  projectId: string;
  computerId: string;
  computer: ComputerDto | null;
  path: string;
  pathHash: string;
  bindingVersion: number;
  status: ProjectBindingStatus;
  platform: string | null;
  canonicalPath: string | null;
  validationRequestId: string | null;
  validationErrorCode: string | null;
  validationError: string | null;
  lastValidatedAt: string | null;
  validatedByRunnerId: string | null;
  validatedBindingVersion: number | null;
  policyVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetailDto extends ProjectDto {
  bindings: ProjectBindingDto[];
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
  computerId: string | null;
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
  runner?: RunnerSummaryDto | null;
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
  phase: ExecutionPhase;
  progress: number;
  progressMode: ProgressMode;
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
  runnerId: string | null;
  repositoryProjectId: string | null;
  repositoryBindingId: string | null;
  repositoryBindingVersion: number | null;
  repositoryDefaultBranch: string | null;
  status: ExecutionStatus;
  phase: ExecutionPhase;
  progress: number;
  progressMode: ProgressMode;
  exitCode: number | null;
  summary: string | null;
  branchName: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  changedFiles: number;
  diffStat: string;
  gitStatus: string;
  diffTruncated: boolean;
  lastRunnerSeq: number;
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
  stream: LogStream;
  eventId: string | null;
  runnerSeq: number | null;
  level: LogLevel;
  message: string;
  timestamp: string;
}

export interface GitExecutionResultDto {
  branchName: string;
  baseCommit: string;
  headCommit: string | null;
  changedFiles: number;
  diffStat: string;
  gitStatus: string;
  diff: string;
  diffTruncated: boolean;
}

/**
 * Response of `GET /api/executions/:id/diff`.
 *
 * The patch is intentionally stored and fetched separately from the execution
 * list so a large unified diff never inflates every execution response.
 * `available` is false when the runtime did not produce a Git artifact (for
 * example a mock execution, a start failure, or a runner that crashed before
 * collecting the result).
 */
export interface ExecutionDiffDto {
  executionId: string;
  available: boolean;
  branchName: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  changedFiles: number;
  diffStat: string;
  gitStatus: string;
  diff: string;
  diffTruncated: boolean;
  createdAt: string | null;
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
