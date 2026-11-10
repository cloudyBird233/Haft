import type { ProjectDto } from '@raft-lite/contracts';
import { GitBranch, ListChecks, PlayCircle } from 'lucide-react';

export function ProjectCard({
  project,
  onOpen,
}: {
  project: ProjectDto;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(project.id)}
      data-testid="project-card"
      data-project-id={project.id}
      aria-label={`View project ${project.name}`}
      className="panel group flex h-full w-full flex-col p-4 text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-[#cfc9bd] hover:shadow-[0_10px_24px_rgba(42,38,31,0.06)] focus-ring"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-black/5 text-[11px] font-bold text-white"
          style={{ backgroundColor: project.color }}
          aria-hidden="true"
        >
          {project.key.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold tracking-[-0.015em] text-ink">
              {project.name}
            </span>
            {project.archivedAt ? (
              <span
                className="rounded-full border border-line bg-[#f3f1ec] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#706c64]"
                data-testid="project-archived-badge"
              >
                Archived
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-faint">
            {project.key}
          </p>
        </div>
      </div>

      <p className="mt-2.5 line-clamp-2 min-h-[32px] text-[11.5px] leading-4 text-muted">
        {project.description || 'No description provided.'}
      </p>

      <div className="mt-3 flex items-center gap-1.5 text-[10.5px] text-faint">
        <GitBranch size={11} aria-hidden="true" />
        <span className="font-mono">{project.defaultBranch}</span>
      </div>

      <div className="mt-3 flex items-center gap-4 border-t border-line pt-2.5 text-[10.5px] text-muted">
        <span className="inline-flex items-center gap-1.5" data-testid="project-task-count">
          <ListChecks size={11} aria-hidden="true" />
          {project.taskCount ?? 0} tasks
        </span>
        <span className="inline-flex items-center gap-1.5" data-testid="project-execution-count">
          <PlayCircle size={11} aria-hidden="true" />
          {project.executionCount ?? 0} runs
        </span>
      </div>
    </button>
  );
}
