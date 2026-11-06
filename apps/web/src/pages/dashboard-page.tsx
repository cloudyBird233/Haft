import { Link } from 'react-router-dom';
import type { ActivityType } from '@raft-lite/contracts';
import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  CircleDot,
  ListChecks,
  Plus,
  RefreshCw,
  Sparkles,
  Users,
  Wifi,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useDashboard } from '../hooks/use-raft-data';
import { useToast } from '../providers/toast-provider';
import { cn, formatShortDateTime, shortId } from '../lib/utils';
import { buttonStyles, Button } from '../components/ui/button';
import { PageHeader, SectionHeader, TextLink } from '../components/ui/page-header';
import { EmptyState, ErrorState, PageLoadingState } from '../components/ui/feedback';
import { Avatar } from '../components/ui/avatar';
import { PriorityBadge, TaskStatusBadge } from '../components/ui/status-badge';

const activityStyles: Record<string, { icon: typeof Activity; className: string }> = {
  'agent.created': { icon: Bot, className: 'bg-[#eef1ee] text-[#4f6a5a]' },
  'agent.updated': { icon: Bot, className: 'bg-[#eef1ee] text-[#4f6a5a]' },
  'agent.deleted': { icon: XCircle, className: 'bg-[#f7efec] text-[#a15b49]' },
  'task.created': { icon: ListChecks, className: 'bg-[#eef1f4] text-[#506b82]' },
  'task.updated': { icon: ListChecks, className: 'bg-[#eef1f4] text-[#506b82]' },
  'task.assigned': { icon: Users, className: 'bg-[#f3f0e9] text-[#7a6742]' },
  'task.status_changed': { icon: Workflow, className: 'bg-[#f3f0e9] text-[#7a6742]' },
  'task.deleted': { icon: XCircle, className: 'bg-[#f7efec] text-[#a15b49]' },
  'execution.started': { icon: Activity, className: 'bg-[#eef1ee] text-[#4f6a5a]' },
  'execution.completed': { icon: CheckCircle2, className: 'bg-[#ebf3ed] text-[#3f7557]' },
  'execution.failed': { icon: XCircle, className: 'bg-[#f7efec] text-[#a14c3a]' },
  'execution.cancelled': { icon: CircleDot, className: 'bg-[#f1efea] text-[#746f65]' },
};

function ActivityGlyph({ type }: { type: ActivityType }): JSX.Element {
  const config = activityStyles[type] ?? { icon: Activity, className: 'bg-surface text-muted' };
  const Icon = config.icon;
  return (
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-lg border border-black/[0.03]',
        config.className,
      )}
    >
      <Icon size={12.5} aria-hidden="true" />
    </span>
  );
}

export function DashboardPage(): JSX.Element {
  const dashboard = useDashboard();
  const { toast } = useToast();
  const data = dashboard.data;

  async function handleRefresh(): Promise<void> {
    const result = await dashboard.refetch();
    if (result.isError) {
      toast({
        title: 'Could not refresh overview',
        description: result.error instanceof Error ? result.error.message : 'Try again.',
        variant: 'error',
      });
    } else {
      toast({ title: 'Overview refreshed', variant: 'success' });
    }
  }

  return (
    <div data-testid="dashboard-page">
      <PageHeader
        eyebrow="Workspace overview"
        title="Overview"
        description="Coordinate agents, move work forward, and keep every execution observable."
        testId="dashboard-header"
        actions={
          <>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => void handleRefresh()}
              aria-label="Refresh overview"
              title="Refresh overview"
              data-testid="dashboard-refresh-button"
              loading={dashboard.isFetching}
            >
              {!dashboard.isFetching ? <RefreshCw size={14} aria-hidden="true" /> : null}
            </Button>
            <Link
              to="/tasks?new=1"
              className={buttonStyles('primary')}
              data-testid="dashboard-new-task-button"
            >
              <Plus size={14} aria-hidden="true" />
              New task
            </Link>
          </>
        }
      />

      {dashboard.isLoading ? (
        <PageLoadingState label="Loading workspace overview" testId="dashboard-loading" />
      ) : dashboard.isError ? (
        <ErrorState
          title="Overview is unavailable"
          description={
            dashboard.error instanceof Error
              ? dashboard.error.message
              : 'The dashboard could not be loaded.'
          }
          onRetry={() => void dashboard.refetch()}
          testId="dashboard-error"
          retryTestId="dashboard-retry-button"
        />
      ) : data ? (
        <div className="space-y-4">
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Workspace metrics">
            <div className="panel p-4" data-testid="dashboard-stat-agents">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10.5px] font-medium text-muted">Total agents</p>
                  <p className="numeric mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-ink">
                    {data.metrics.agentsTotal}
                  </p>
                </div>
                <span className="flex size-8 items-center justify-center rounded-xl border border-line bg-[#f7f5f0] text-muted">
                  <Users size={15} aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-[10.5px] text-faint">
                {data.metrics.agentsOnline} reachable now
              </p>
            </div>
            <div className="panel p-4" data-testid="dashboard-stat-online">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10.5px] font-medium text-muted">Online agents</p>
                  <p className="numeric mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-ink">
                    {data.metrics.agentsOnline}
                  </p>
                </div>
                <span className="flex size-8 items-center justify-center rounded-xl border border-[#dbe6de] bg-[#eff5f1] text-success">
                  <Wifi size={15} aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-[10.5px] text-faint">Ready to accept assignments</p>
            </div>
            <div className="panel p-4" data-testid="dashboard-stat-running">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10.5px] font-medium text-muted">In progress</p>
                  <p className="numeric mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-ink">
                    {data.metrics.tasksRunning}
                  </p>
                </div>
                <span className="flex size-8 items-center justify-center rounded-xl border border-line bg-[#f7f5f0] text-info">
                  <Activity size={15} aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-[10.5px] text-faint">Active task executions</p>
            </div>
            <div className="panel p-4" data-testid="dashboard-stat-completed">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10.5px] font-medium text-muted">Completed</p>
                  <p className="numeric mt-2 text-[28px] font-semibold leading-none tracking-[-0.04em] text-ink">
                    {data.metrics.tasksCompleted}
                  </p>
                </div>
                <span className="flex size-8 items-center justify-center rounded-xl border border-[#dbe6de] bg-[#eff5f1] text-success">
                  <CheckCircle2 size={15} aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-[10.5px] text-faint">
                {data.metrics.tasksTotal} tasks in this workspace
              </p>
            </div>
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(310px,0.85fr)]">
            <div className="min-w-0 space-y-4">
              <section className="panel overflow-hidden" aria-labelledby="recent-tasks-title" data-testid="dashboard-recent-tasks">
                <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
                  <SectionHeader
                    title="Recent tasks"
                    description="The latest work moving through the workspace"
                  />
                  <TextLink to="/tasks" testId="dashboard-view-all-tasks">
                    View all <ArrowUpRight className="inline" size={10} aria-hidden="true" />
                  </TextLink>
                </div>
                {data.recentTasks.length > 0 ? (
                  <div className="divide-y divide-line">
                    {data.recentTasks.map((task) => (
                      <Link
                        key={task.id}
                        to={`/tasks?task=${encodeURIComponent(task.id)}`}
                        data-testid="dashboard-recent-task"
                        data-task-id={task.id}
                        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#fbfaf7] focus-ring"
                      >
                        <span
                          className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-[9px] font-bold text-muted"
                          aria-hidden="true"
                        >
                          {task.project.key.slice(0, 2)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12px] font-semibold text-ink">{task.title}</p>
                          <p className="mt-0.5 text-[10px] text-faint">
                            {task.project.name} · {shortId(task.id)}
                          </p>
                        </div>
                        <PriorityBadge priority={task.priority} showLabel={false} className="hidden sm:inline-flex" />
                        <TaskStatusBadge status={task.status} className="hidden sm:inline-flex" />
                        {task.assignee ? (
                          <Avatar name={task.assignee.name} size="sm" />
                        ) : (
                          <span className="flex size-6 items-center justify-center rounded-full border border-dashed border-line-strong text-faint">
                            <CircleDot size={10} aria-hidden="true" />
                          </span>
                        )}
                        <ArrowUpRight
                          size={12}
                          className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
                          aria-hidden="true"
                        />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="p-4">
                    <EmptyState
                      title="No tasks yet"
                      description="Create a task to start moving work through the board."
                      testId="dashboard-tasks-empty"
                      action={
                        <Link to="/tasks?new=1" className={buttonStyles('secondary', 'sm')}>
                          <Plus size={12} aria-hidden="true" />
                          Create task
                        </Link>
                      }
                    />
                  </div>
                )}
              </section>

              <section className="panel overflow-hidden" aria-labelledby="activity-title" data-testid="dashboard-activity-feed">
                <div className="border-b border-line px-4 py-3.5">
                  <SectionHeader
                    title="Recent activity"
                    description="A trace of agent, task, and execution events"
                  />
                </div>
                {data.recentActivities.length > 0 ? (
                  <ol className="divide-y divide-line">
                    {data.recentActivities.map((activity) => (
                      <li
                        key={activity.id}
                        data-testid="dashboard-activity"
                        data-activity-type={activity.type}
                        className="flex items-start gap-3 px-4 py-3"
                      >
                        <ActivityGlyph type={activity.type} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[11.5px] leading-5 text-ink">{activity.summary}</p>
                          <p className="mt-0.5 text-[10px] text-faint">
                            {formatShortDateTime(activity.createdAt)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="p-4">
                    <EmptyState
                      title="No activity recorded"
                      description="Actions across the workspace will appear here."
                      testId="dashboard-activity-empty"
                    />
                  </div>
                )}
              </section>
            </div>

            <div className="space-y-4">
              <section className="panel overflow-hidden" aria-labelledby="agents-status-title" data-testid="dashboard-agent-overview">
                <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
                  <SectionHeader title="Agent status" description="Who is available right now" />
                  <TextLink to="/agents" testId="dashboard-view-all-agents">
                    Manage
                  </TextLink>
                </div>
                <div className="divide-y divide-line">
                  {data.agents.map((agent) => (
                    <Link
                      key={agent.id}
                      to={`/agents?agent=${encodeURIComponent(agent.id)}`}
                      data-testid="dashboard-agent-row"
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#fbfaf7] focus-ring"
                    >
                      <Avatar name={agent.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold text-ink">{agent.name}</p>
                        <p className="truncate text-[10px] text-faint">{agent.role}</p>
                      </div>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium',
                          agent.status === 'idle' && 'border-[#d5e4db] bg-[#eef5f0] text-[#3f7557]',
                          agent.status === 'busy' && 'border-[#d6e0e8] bg-[#eef3f6] text-[#4f6f8f]',
                          agent.status === 'offline' && 'border-line bg-surface text-faint',
                          agent.status === 'error' && 'border-[#ecd8d2] bg-[#fbf1ee] text-[#a64736]',
                        )}
                        data-testid="dashboard-agent-status"
                        data-status={agent.status}
                      >
                        <span className="size-1 rounded-full bg-current" aria-hidden="true" />
                        {agent.status === 'idle'
                          ? 'Idle'
                          : agent.status === 'busy'
                            ? 'Busy'
                            : agent.status === 'offline'
                              ? 'Offline'
                              : 'Error'}
                      </span>
                    </Link>
                  ))}
                </div>
                <div className="flex items-center gap-2 border-t border-line bg-[#fbfaf7] px-4 py-2.5 text-[10px] text-faint">
                  <CircleDot size={10} aria-hidden="true" />
                  {data.metrics.agentsOnline} of {data.metrics.agentsTotal} agents online
                </div>
              </section>

              <section className="panel p-4" data-testid="dashboard-runtime-card">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-xl bg-ink text-white">
                    <Sparkles size={14} aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-[12.5px] font-semibold text-ink">Mock runtime</h2>
                    <p className="text-[10px] text-faint">Phase 1 execution engine</p>
                  </div>
                  <span className="ml-auto rounded-full border border-line bg-surface px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
                    Ready
                  </span>
                </div>
                <p className="mt-3 text-[11.5px] leading-5 text-muted">
                  Every execution is deterministic and fully observable. Real Codex and OpenCode
                  adapters plug into the same runtime seam later.
                </p>
                <ul className="mt-3 space-y-1.5 text-[10.5px] text-muted">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 size={11} className="text-success" aria-hidden="true" />
                    Socket.IO log streaming
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 size={11} className="text-success" aria-hidden="true" />
                    Step, progress, and failure controls
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 size={11} className="text-success" aria-hidden="true" />
                    Isolated test database
                  </li>
                </ul>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
