import type { TaskDto } from '@raft-lite/contracts';
import { ArrowUpRight, CalendarDays } from 'lucide-react';
import { cn, formatDate, shortId } from '../../lib/utils';
import { Avatar } from '../../components/ui/avatar';
import { PriorityBadge, TaskStatusBadge } from '../../components/ui/status-badge';

export function TaskCard({
  task,
  onOpen,
}: {
  task: TaskDto;
  onOpen: (taskId: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      data-testid="task-card"
      data-task-id={task.id}
      data-status={task.status}
      aria-label={`Open task ${task.title}`}
      className="group w-full rounded-xl border border-line bg-panel p-3 text-left shadow-[0_1px_2px_rgba(26,24,20,0.03)] transition-all duration-150 hover:border-[#cfcabf] hover:shadow-soft focus-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: task.project.color }} aria-hidden="true" />
          {task.project.key}-{shortId(task.id).slice(-3)}
        </span>
        <TaskStatusBadge status={task.status} />
      </div>
      <h3 className="mt-2.5 line-clamp-2 text-[12.5px] font-semibold leading-[1.45] tracking-[-0.005em] text-ink">
        {task.title}
      </h3>
      {task.description ? (
        <p className="mt-1.5 line-clamp-2 text-[11px] leading-[1.55] text-muted">{task.description}</p>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line/80 pt-2.5">
        <PriorityBadge priority={task.priority} />
        {task.assignee ? (
          <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted">
            <Avatar name={task.assignee.name} size="sm" />
            <span className="truncate">{task.assignee.name}</span>
          </span>
        ) : (
          <span className="text-[10.5px] italic text-faint">Unassigned</span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-[9.5px] text-faint">
        <span className="inline-flex items-center gap-1">
          <CalendarDays size={10} aria-hidden="true" />
          {formatDate(task.updatedAt)}
        </span>
        <span className={cn('inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100')}>
          Open
          <ArrowUpRight size={10} aria-hidden="true" />
        </span>
      </div>
    </button>
  );
}
