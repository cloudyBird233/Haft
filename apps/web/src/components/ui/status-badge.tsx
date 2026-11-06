import type { AgentStatus, ExecutionStatus, TaskPriority, TaskStatus } from '@raft-lite/contracts';
import {
  AGENT_STATUS_LABELS,
  EXECUTION_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
} from '@raft-lite/contracts';
import { cn } from '../../lib/utils';

const agentTone: Record<AgentStatus, string> = {
  idle: 'border-[#d5e4db] bg-[#eef5f0] text-[#3f7557]',
  busy: 'border-[#d6e0e8] bg-[#eef3f6] text-[#4f6f8f]',
  offline: 'border-line bg-[#f3f1ec] text-[#7b776e]',
  error: 'border-[#ecd8d2] bg-[#fbf1ee] text-[#a64736]',
};

const taskTone: Record<TaskStatus, string> = {
  todo: 'border-line bg-[#f4f2ed] text-[#716e66]',
  claimed: 'border-[#d6e0e8] bg-[#eef3f6] text-[#4f6f8f]',
  in_progress: 'border-[#d5e4db] bg-[#edf5f0] text-[#356a4e]',
  in_review: 'border-[#eadfc7] bg-[#faf4e8] text-[#8a641e]',
  done: 'border-[#cfe0d6] bg-[#e9f3ed] text-[#336248]',
  failed: 'border-[#ecd8d2] bg-[#fbf1ee] text-[#a64736]',
  cancelled: 'border-line bg-[#f3f1ec] text-[#706c64]',
};

const executionTone: Record<ExecutionStatus, string> = {
  running: 'border-[#d5e4db] bg-[#edf5f0] text-[#356a4e]',
  completed: 'border-[#cfe0d6] bg-[#e9f3ed] text-[#336248]',
  failed: 'border-[#ecd8d2] bg-[#fbf1ee] text-[#a64736]',
  cancelled: 'border-line bg-[#f3f1ec] text-[#706c64]',
};

const priorityTone: Record<TaskPriority, string> = {
  low: 'text-[#7b776e]',
  medium: 'text-[#5e5a52]',
  high: 'text-[#8a641e]',
  urgent: 'text-[#a64736]',
};

const base =
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.015em] whitespace-nowrap';

function Dot({ tone = 'currentColor' }: { tone?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 rounded-full"
      style={{ backgroundColor: tone }}
    />
  );
}

export function AgentStatusBadge({
  status,
  className,
}: {
  status: AgentStatus;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(base, agentTone[status], className)}
      data-testid="agent-status-badge"
      data-status={status}
    >
      <Dot />
      {AGENT_STATUS_LABELS[status]}
    </span>
  );
}

export function TaskStatusBadge({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(base, taskTone[status], className)}
      data-testid="task-status-badge"
      data-status={status}
    >
      <Dot />
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

export function ExecutionStatusBadge({
  status,
  className,
}: {
  status: ExecutionStatus;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(base, executionTone[status], className)}
      data-testid="execution-status-badge"
      data-status={status}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          status === 'running' && 'animate-pulse',
        )}
        style={{ backgroundColor: 'currentColor' }}
        aria-hidden="true"
      />
      {EXECUTION_STATUS_LABELS[status]}
    </span>
  );
}

export function PriorityBadge({
  priority,
  showLabel = true,
  className,
}: {
  priority: TaskPriority;
  showLabel?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-medium',
        priorityTone[priority],
        className,
      )}
      data-testid="task-priority-badge"
      data-priority={priority}
    >
      <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
        <path d="M2 8V2.5M2 2.5h5L5.6 4 7 5.5H2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      {showLabel ? TASK_PRIORITY_LABELS[priority] : null}
    </span>
  );
}
