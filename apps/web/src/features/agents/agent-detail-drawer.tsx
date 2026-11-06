import type { AgentDetailDto } from '@raft-lite/contracts';
import { RUNTIME_LABELS } from '@raft-lite/contracts';
import { formatDate, formatDateTime } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog';
import { EmptyState, ErrorState } from '../../components/ui/feedback';
import { ExecutionStatusBadge, TaskStatusBadge } from '../../components/ui/status-badge';
import { Avatar } from '../../components/ui/avatar';
import { useAgent } from '../../hooks/use-raft-data';
import { Link } from 'react-router-dom';

export function AgentDetailDrawer({
  agentId,
  onOpenChange,
  onEdit,
  onDelete,
}: {
  agentId: string | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (agent: AgentDetailDto) => void;
  onDelete: (agent: AgentDetailDto) => void;
}): JSX.Element {
  const query = useAgent(agentId);
  const agent = query.data;

  return (
    <Dialog open={Boolean(agentId)} onOpenChange={onOpenChange}>
      <DialogContent
        side="drawer"
        testId="agent-detail-panel"
        ariaLabel={agent ? `Agent details for ${agent.name}` : 'Agent details'}
      >
        <div className="flex-1 overflow-y-auto">
          <div className="border-b border-line bg-[#fbfaf7] px-5 pb-4 pt-5 pr-14">
            <p className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.15em] text-faint">
              Agent profile
            </p>
            {agent ? (
              <div className="flex items-start gap-3">
                <Avatar name={agent.name} size="lg" />
                <div className="min-w-0">
                  <DialogTitle className="text-[18px] font-semibold tracking-[-0.025em] text-ink">
                    {agent.name}
                  </DialogTitle>
                  <DialogDescription className="mt-0.5 text-[12px] text-muted">
                    {agent.role}
                  </DialogDescription>
                </div>
              </div>
            ) : (
              <>
                <DialogTitle className="text-[18px] font-semibold text-ink">
                  Agent details
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Loading agent profile and history.
                </DialogDescription>
              </>
            )}
          </div>

          {query.isLoading ? (
            <div className="flex min-h-[360px] items-center justify-center" role="status">
              <span className="text-[12px] text-muted">Loading agent…</span>
            </div>
          ) : query.isError ? (
            <div className="p-5">
              <ErrorState
                title="Agent could not be loaded"
                description={query.error instanceof Error ? query.error.message : 'Please try again.'}
                onRetry={() => void query.refetch()}
                testId="agent-detail-error"
                retryTestId="agent-detail-retry-button"
              />
            </div>
          ) : agent ? (
            <div className="space-y-6 px-5 py-5">
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                  About
                </h3>
                <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-5 text-muted">
                  {agent.description || 'No description provided.'}
                </p>
              </section>

              <section className="rounded-xl border border-line bg-[#fbfaf7] p-3.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                  Configuration
                </h3>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[11.5px]">
                  <div>
                    <dt className="text-faint">Runtime</dt>
                    <dd className="mt-0.5 font-medium text-ink">{RUNTIME_LABELS[agent.runtime]}</dd>
                  </div>
                  <div>
                    <dt className="text-faint">Computer</dt>
                    <dd className="mt-0.5 font-medium text-ink">
                      {agent.computer?.name ?? 'Unassigned'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-faint">Created</dt>
                    <dd className="mt-0.5 font-medium text-ink">{formatDate(agent.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-faint">Last active</dt>
                    <dd className="mt-0.5 font-medium text-ink">
                      {agent.lastActiveAt ? formatDateTime(agent.lastActiveAt) : 'No activity yet'}
                    </dd>
                  </div>
                </dl>
              </section>

              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                  Current task
                </h3>
                {agent.currentTask ? (
                  <Link
                    to={`/tasks?task=${encodeURIComponent(agent.currentTask.id)}`}
                    onClick={() => onOpenChange(false)}
                    data-testid="agent-current-task"
                    className="mt-2 block rounded-xl border border-line bg-panel p-3.5 transition-colors hover:border-line-strong focus-ring"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[12.5px] font-semibold leading-5 text-ink">
                        {agent.currentTask.title}
                      </p>
                      <TaskStatusBadge status={agent.currentTask.status} />
                    </div>
                    <p className="mt-1 text-[10.5px] text-faint">
                      {agent.currentTask.projectKey} · Updated{' '}
                      {formatDate(agent.currentTask.updatedAt)}
                    </p>
                  </Link>
                ) : (
                  <p className="mt-2 rounded-xl border border-dashed border-line-strong px-3 py-4 text-[11.5px] text-faint">
                    No active task. This agent is ready for new work.
                  </p>
                )}
              </section>

              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                  Execution history
                </h3>
                {agent.recentExecutions.length > 0 ? (
                  <div className="mt-2 divide-y divide-line rounded-xl border border-line" data-testid="agent-execution-history">
                    {agent.recentExecutions.map((execution) => (
                      <Link
                        key={execution.id}
                        to={`/executions/${execution.id}`}
                        onClick={() => onOpenChange(false)}
                        data-testid="agent-execution-row"
                        className="flex items-center justify-between gap-3 px-3 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface focus-ring"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[11.5px] font-medium text-ink">
                            {execution.task.title}
                          </p>
                          <p className="mt-0.5 text-[10px] text-faint">
                            {formatDate(execution.createdAt)} · {execution.progress}%
                          </p>
                        </div>
                        <ExecutionStatusBadge status={execution.status} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No execution history"
                    description="Runs started by this agent will appear here."
                    className="mt-2 min-h-[120px] py-6"
                    testId="agent-execution-empty"
                  />
                )}
              </section>
            </div>
          ) : null}
        </div>

        {agent ? (
          <div className="flex items-center justify-between gap-2 border-t border-line bg-[#fcfbf8] px-5 py-3.5">
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger/[0.06] hover:text-danger"
              onClick={() => onDelete(agent)}
              data-testid="agent-delete-button"
            >
              Delete
            </Button>
            <Button
              variant="primary"
              onClick={() => onEdit(agent)}
              data-testid="agent-detail-edit-button"
            >
              Edit agent
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
