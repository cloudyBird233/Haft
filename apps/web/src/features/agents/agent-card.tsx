import type { AgentDto } from '@raft-lite/contracts';
import { RUNTIME_LABELS } from '@raft-lite/contracts';
import { ChevronRight, Clock3, Monitor } from 'lucide-react';
import { formatShortDateTime } from '../../lib/utils';
import { Avatar } from '../../components/ui/avatar';
import { AgentStatusBadge } from '../../components/ui/status-badge';

export function AgentCard({
  agent,
  onOpen,
}: {
  agent: AgentDto;
  onOpen: (agentId: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      data-testid="agent-card"
      data-agent-id={agent.id}
      data-status={agent.status}
      aria-label={`View agent ${agent.name}`}
      className="group flex w-full flex-col rounded-2xl border border-line bg-panel p-4 text-left shadow-[0_1px_2px_rgba(26,24,20,0.025)] transition-all hover:border-[#cec9be] hover:shadow-soft focus-ring"
    >
      <div className="flex items-start gap-3">
        <Avatar name={agent.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-ink">
              {agent.name}
            </h3>
            <AgentStatusBadge status={agent.status} />
          </div>
          <p className="mt-0.5 truncate text-[11px] font-medium text-muted">{agent.role}</p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 min-h-[34px] text-[11.5px] leading-[1.55] text-muted">
        {agent.description || 'No description provided.'}
      </p>
      <div className="mt-3.5 flex items-center gap-3 border-t border-line/80 pt-3 text-[10px] text-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded border border-line bg-surface px-1.5 py-0.5 font-semibold text-muted">
            {RUNTIME_LABELS[agent.runtime]}
          </span>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1">
          <Monitor size={10} aria-hidden="true" />
          <span className="truncate">{agent.computer?.name ?? 'No computer'}</span>
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
          <Clock3 size={10} aria-hidden="true" />
          {agent.lastActiveAt ? formatShortDateTime(agent.lastActiveAt) : 'No activity'}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-end text-[10px] font-medium text-muted opacity-70 transition-opacity group-hover:opacity-100">
        View details
        <ChevronRight size={11} aria-hidden="true" />
      </div>
    </button>
  );
}
