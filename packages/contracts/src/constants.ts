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

/**
 * Protocol-phase indicator persisted independently of `status`/`phase`.
 * It must never be rendered as a replacement for the user-visible status.
 */
export const DISPATCH_STATES = [
  'created',
  'repository_preparing',
  'repository_ready',
  'start_sent',
  'running',
  'terminal',
] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

export const DISPATCH_STATE_LABELS: Record<DispatchState, string> = {
  created: 'Created',
  repository_preparing: 'Preparing repository',
  repository_ready: 'Repository ready',
  start_sent: 'Starting CLI',
  running: 'Running',
  terminal: 'Terminal',
};

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

/**
 * Repository binding validation state. Only a successful runner validation may
 * move a binding to `ready`; client input can never set this field directly.
 */
export const PROJECT_BINDING_STATUSES = ['unverified', 'ready', 'missing', 'error'] as const;
export type ProjectBindingStatus = (typeof PROJECT_BINDING_STATUSES)[number];

export const PROJECT_BINDING_STATUS_LABELS: Record<ProjectBindingStatus, string> = {
  unverified: 'Unverified',
  ready: 'Ready',
  missing: 'Path missing',
  error: 'Validation failed',
};

export const RUNNER_PROTOCOL_VERSION = 1 as const;

/**
 * Capability registry for the additive Phase 2 runner protocol.
 *
 * A feature name is a contract, not an implementation claim: a runner only
 * advertises the features it actually implements. Consumers must treat a
 * missing feature (including runners that omit `capabilities.features`) as
 * "not supported" and fail closed.
 */
export const RUNNER_FEATURES = [
  'project-binding-v1',
  'repository-validation-v1',
  'repository-path-policy-v1',
  'repository-handshake-v1',
  'log-replay-v1',
  'contiguous-log-ack-v1',
  'terminal-log-barrier-v1',
  'terminal-log-integrity-v1',
] as const;
export type RunnerFeature = (typeof RUNNER_FEATURES)[number];

/** Terminal outcomes carried by the additive `execution.terminal` message. */
export const TERMINAL_OUTCOMES = ['completed', 'failed', 'cancelled'] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/** Whether the runner could collect its complete log stream. */
export const LOG_COLLECTION_STATUSES = ['complete', 'incomplete'] as const;
export type LogCollectionStatus = (typeof LOG_COLLECTION_STATUSES)[number];

/**
 * Server-side log integrity vocabulary. `unknown` is the only correct value
 * when a terminal message omits `logCollection`; it must never default to
 * `complete`.
 */
export const LOG_INTEGRITY_STATUSES = [
  'unknown',
  'complete',
  'incomplete',
  'legacy_inferred',
] as const;
export type LogIntegrityStatus = (typeof LOG_INTEGRITY_STATUSES)[number];

/**
 * Phase 2 error and audit code registry.
 *
 * This is the single source of truth for codes introduced by P2-01/P2-02/
 * P2-03/P2-08/P2-09. Existing v1 runtime codes (for example
 * `RUNNER_AUTH_FAILED`) deliberately stay in their current modules until the
 * owning card migrates them; they are not redefined here to avoid duplicate
 * registries.
 */
export const ERROR_CODES = {
  // P2-01 project and repository binding
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_KEY_CONFLICT: 'PROJECT_KEY_CONFLICT',
  PROJECT_HAS_TASKS: 'PROJECT_HAS_TASKS',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  BINDING_NOT_FOUND: 'BINDING_NOT_FOUND',
  BINDING_DUPLICATE_COMPUTER: 'BINDING_DUPLICATE_COMPUTER',
  BINDING_FIELD_IMMUTABLE: 'BINDING_FIELD_IMMUTABLE',
  BINDING_PATH_INVALID: 'BINDING_PATH_INVALID',
  PROJECT_BINDING_MISSING: 'PROJECT_BINDING_MISSING',
  PROJECT_BINDING_NOT_READY: 'PROJECT_BINDING_NOT_READY',

  // P2-02 repository validation, path policy and handshake
  PROJECT_BINDING_UNSUPPORTED: 'PROJECT_BINDING_UNSUPPORTED',
  BINDING_VERSION_STALE: 'BINDING_VERSION_STALE',
  STALE_REPOSITORY_VALIDATION: 'STALE_REPOSITORY_VALIDATION',
  RUNNER_FEATURE_UNSUPPORTED: 'RUNNER_FEATURE_UNSUPPORTED',
  RUNNER_OFFLINE: 'RUNNER_OFFLINE',
  REPOSITORY_VALIDATION_TIMEOUT: 'REPOSITORY_VALIDATION_TIMEOUT',
  REPOSITORY_HANDSHAKE_TIMEOUT: 'REPOSITORY_HANDSHAKE_TIMEOUT',
  REPOSITORY_CONTEXT_REJECTED: 'REPOSITORY_CONTEXT_REJECTED',
  REPOSITORY_CONTEXT_MISMATCH: 'REPOSITORY_CONTEXT_MISMATCH',
  REPOSITORY_CONTEXT_CONFLICT: 'REPOSITORY_CONTEXT_CONFLICT',
  REPOSITORY_CONTEXT_NOT_READY: 'REPOSITORY_CONTEXT_NOT_READY',
  REPOSITORY_BINDING_CHANGED: 'REPOSITORY_BINDING_CHANGED',
  REPOSITORY_POLICY_CHANGED: 'REPOSITORY_POLICY_CHANGED',
  REPOSITORY_POLICY_NOT_CONFIGURED: 'REPOSITORY_POLICY_NOT_CONFIGURED',
  START_ACCEPT_TIMEOUT: 'START_ACCEPT_TIMEOUT',
  RUNNER_START_UNCONFIRMED: 'RUNNER_START_UNCONFIRMED',
  REPO_PATH_INVALID: 'REPO_PATH_INVALID',
  REPO_PATH_NOT_ABSOLUTE: 'REPO_PATH_NOT_ABSOLUTE',
  REPO_PATH_TRAVERSAL: 'REPO_PATH_TRAVERSAL',
  REPO_UNC_NOT_ALLOWED: 'REPO_UNC_NOT_ALLOWED',
  REPO_PATH_OUTSIDE_ALLOWED_ROOTS: 'REPO_PATH_OUTSIDE_ALLOWED_ROOTS',
  REPO_PATH_NOT_FOUND: 'REPO_PATH_NOT_FOUND',
  REPO_NOT_GIT_ROOT: 'REPO_NOT_GIT_ROOT',
  REPO_BARE_UNSUPPORTED: 'REPO_BARE_UNSUPPORTED',
  REPO_PATH_IS_WORKTREE: 'REPO_PATH_IS_WORKTREE',
  REPO_PATH_NESTED_IN_WORKTREE_ROOT: 'REPO_PATH_NESTED_IN_WORKTREE_ROOT',
  REPO_DEFAULT_BRANCH_NOT_FOUND: 'REPO_DEFAULT_BRANCH_NOT_FOUND',
  REPO_VALIDATION_FAILED: 'REPO_VALIDATION_FAILED',

  // P2-03 authentication
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CSRF_INVALID: 'CSRF_INVALID',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',

  // P2-08 concurrency, idempotency and active execution release
  EXECUTION_ALREADY_RUNNING: 'EXECUTION_ALREADY_RUNNING',
  AGENT_BUSY: 'AGENT_BUSY',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  ACTIVE_EXECUTION_RELEASED: 'ACTIVE_EXECUTION_RELEASED',
  ACTIVE_EXECUTION_RELEASE_SKIPPED: 'ACTIVE_EXECUTION_RELEASE_SKIPPED',
  STALE_ACTIVE_EXECUTION_CLEARED: 'STALE_ACTIVE_EXECUTION_CLEARED',

  // P2-09 log sequencing, replay, barrier and integrity
  LOG_RUNNER_SEQ_CONFLICT: 'LOG_RUNNER_SEQ_CONFLICT',
  LOG_EVENT_ID_CONFLICT: 'LOG_EVENT_ID_CONFLICT',
  LOG_SEQ_ALLOCATION_FAILED: 'LOG_SEQ_ALLOCATION_FAILED',
  LOG_GAP_DETECTED: 'LOG_GAP_DETECTED',
  LOG_REPLAY_UNAVAILABLE: 'LOG_REPLAY_UNAVAILABLE',
  LOG_TERMINAL_SEQ_INCONSISTENT: 'LOG_TERMINAL_SEQ_INCONSISTENT',
  LOG_TERMINAL_LOG_COLLECTION_INVALID: 'LOG_TERMINAL_LOG_COLLECTION_INVALID',
  LOG_TERMINAL_CONFLICT: 'LOG_TERMINAL_CONFLICT',
  LOG_INTEGRITY_INCOMPLETE: 'LOG_INTEGRITY_INCOMPLETE',
  LOG_BARRIER_TIMEOUT: 'LOG_BARRIER_TIMEOUT',
  RUNNER_LOG_SPOOL_FAILED: 'RUNNER_LOG_SPOOL_FAILED',
  RUNNER_LOG_SPOOL_OVERFLOW: 'RUNNER_LOG_SPOOL_OVERFLOW',
  RUNNER_LOG_SEQ_GAP: 'RUNNER_LOG_SEQ_GAP',
  RUNNER_LOG_COLLECTION_ABORTED: 'RUNNER_LOG_COLLECTION_ABORTED',
  RUNNER_INTERRUPTED: 'RUNNER_INTERRUPTED',
  RUNNER_DISK_SPACE_LOW: 'RUNNER_DISK_SPACE_LOW',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Runtime-checkable values derived from the single `ERROR_CODES` source. */
export const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as readonly ErrorCode[];

/** Failure reasons that make a log collection explicitly incomplete. */
export const LOG_COLLECTION_REASON_CODES = [
  ERROR_CODES.RUNNER_LOG_SPOOL_FAILED,
  ERROR_CODES.RUNNER_LOG_SPOOL_OVERFLOW,
  ERROR_CODES.RUNNER_LOG_SEQ_GAP,
  ERROR_CODES.RUNNER_LOG_COLLECTION_ABORTED,
] as const;
export type LogCollectionReasonCode = (typeof LOG_COLLECTION_REASON_CODES)[number];

/**
 * Engineering acceptance vocabulary used by phase reports. These are reporting
 * states, not product execution states, and must not be added to the Execution
 * state machine.
 */
export const ACCEPTANCE_STATUSES = [
  'PASS',
  'FAIL',
  'BLOCKED',
  'PARTIAL',
  'NOT_VERIFIED',
  'SKIPPED',
  'INCONCLUSIVE',
] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

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
