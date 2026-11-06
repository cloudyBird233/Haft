import type { TaskDto } from '@raft-lite/contracts';
import { TASK_LANES } from '@raft-lite/contracts';
import { cn } from '../../lib/utils';
import { TaskCard } from './task-card';

const laneAccent: Record<string, string> = {
  todo: 'bg-[#a6a298]',
  active: 'bg-[#5f7f70]',
  review: 'bg-[#ad863c]',
  done: 'bg-[#4d7d5d]',
  stopped: 'bg-[#a67b70]',
};

export function TaskBoard({
  tasks,
  onOpen,
}: {
  tasks: TaskDto[];
  onOpen: (taskId: string) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto pb-3" data-testid="task-board">
      <div className="grid min-w-[980px] grid-cols-5 gap-3">
        {TASK_LANES.map((lane) => {
          const laneTasks = tasks.filter((task) => lane.statuses.includes(task.status));
          return (
            <section
              key={lane.id}
              data-testid={`task-lane-${lane.id}`}
              data-lane={lane.id}
              aria-labelledby={`task-lane-title-${lane.id}`}
              className="flex min-h-[430px] flex-col rounded-2xl border border-line/85 bg-[#f8f7f3]/75 p-2"
            >
              <header className="flex items-center gap-2 px-1.5 pb-2.5 pt-1">
                <span className={cn('size-1.5 rounded-full', laneAccent[lane.id])} aria-hidden="true" />
                <h2
                  id={`task-lane-title-${lane.id}`}
                  className="text-[11px] font-semibold text-ink"
                >
                  {lane.label}
                </h2>
                <span
                  className="numeric ml-auto rounded-full border border-line bg-panel px-1.5 py-0.5 text-[9.5px] font-medium text-faint"
                  data-testid={`task-lane-${lane.id}-count`}
                >
                  {laneTasks.length}
                </span>
              </header>
              <div className="flex flex-1 flex-col gap-2">
                {laneTasks.length > 0 ? (
                  laneTasks.map((task) => <TaskCard key={task.id} task={task} onOpen={onOpen} />)
                ) : (
                  <div
                    className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line-strong/80 px-3 py-8 text-center text-[10.5px] leading-4 text-faint"
                    data-testid={`task-lane-${lane.id}-empty`}
                  >
                    No tasks
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
