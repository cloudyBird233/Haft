export const AGENT_RUNTIMES = ['mock', 'codex', 'opencode'] as const;
export type AgentRuntimeType = (typeof AGENT_RUNTIMES)[number];

/** Runtimes that can be dispatched when their runtime prerequisites are met. */
export const EXECUTABLE_RUNTIMES = ['mock', 'codex', 'opencode'] as const;

/** Runtimes that require a connected Haft Agent Runner. */
export const RUNNER_RUNTIMES = ['codex', 'opencode'] as const;
export type RunnerRuntimeType = (typeof RUNNER_RUNTIMES)[number];

export const AGENT_STATUSES = ['idle', 'busy', 'offline', 'error'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TASK_STATUSES = [
  'todo',
  'claimed',
  'in_progress',
  'in_review',
  'done',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const EXECUTION_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const LOG_LEVELS = ['info', 'success', 'warning', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const EXECUTION_PHASES = [
  'queued',
  'preparing',
  'running',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export const PROGRESS_MODES = ['determinate', 'indeterminate'] as const;
export type ProgressMode = (typeof PROGRESS_MODES)[number];

export const RUNNER_STATUSES = ['online', 'offline', 'busy', 'degraded'] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

export const RUNNER_PROTOCOL_VERSION = 1 as const;

/**
 * Maximum size of a collected unified patch that the runner may submit and the
 * API may persist. Diffs above this size are truncated by the runner and the
 * `diffTruncated` flag is set. The value is a byte budget for UTF-8 content.
 */
export const EXECUTION_DIFF_MAX_BYTES = 1024 * 1024;

export const ACTIVITY_TYPES = [
  'agent.created',
  'agent.updated',
  'agent.deleted',
  'task.created',
  'task.updated',
  'task.assigned',
  'task.status_changed',
  'task.deleted',
  'execution.started',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'workspace.seeded',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  busy: 'Busy',
  offline: 'Offline',
  error: 'Error',
};

export const RUNTIME_LABELS: Record<AgentRuntimeType, string> = {
  mock: 'Mock',
  codex: 'Codex CLI',
  opencode: 'OpenCode CLI',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  claimed: 'Claimed',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const EXECUTION_STATUS_LABELS: Record<ExecutionStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const EXECUTION_PHASE_LABELS: Record<ExecutionPhase, string> = {
  queued: 'Queued',
  preparing: 'Preparing workspace',
  running: 'Running',
  finalizing: 'Collecting results',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PROGRESS_MODE_LABELS: Record<ProgressMode, string> = {
  determinate: 'Determinate',
  indeterminate: 'Indeterminate',
};

export const LOG_STREAM_LABELS: Record<LogStream, string> = {
  stdout: 'stdout',
  stderr: 'stderr',
  system: 'system',
};

export const RUNNER_STATUS_LABELS: Record<RunnerStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  busy: 'Busy',
  degraded: 'Degraded',
};

/**
 * Canonical task state machine. The API enforces this map.
 * Terminal states intentionally have no outgoing transitions in this demo.
 */
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['claimed', 'cancelled'],
  claimed: ['todo', 'in_progress', 'cancelled'],
  in_progress: ['in_review', 'done', 'failed', 'cancelled'],
  in_review: ['in_progress', 'done', 'failed', 'cancelled'],
  done: [],
  failed: ['todo', 'cancelled'],
  cancelled: ['todo'],
};

export type TaskLaneId = 'todo' | 'active' | 'review' | 'done' | 'stopped';

export interface TaskLane {
  id: TaskLaneId;
  label: string;
  statuses: readonly TaskStatus[];
}

/** Visual Kanban grouping; cards still expose their exact status. */
export const TASK_LANES: readonly TaskLane[] = [
  { id: 'todo', label: 'To do', statuses: ['todo'] },
  { id: 'active', label: 'Active', statuses: ['claimed', 'in_progress'] },
  { id: 'review', label: 'In review', statuses: ['in_review'] },
  { id: 'done', label: 'Done', statuses: ['done'] },
  { id: 'stopped', label: 'Stopped', statuses: ['failed', 'cancelled'] },
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[status].length === 0;
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from].includes(to);
}
