export const AGENT_RUNTIMES = ['mock', 'codex', 'opencode'] as const;
export type AgentRuntimeType = (typeof AGENT_RUNTIMES)[number];

export const EXECUTABLE_RUNTIMES = ['mock'] as const;

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
