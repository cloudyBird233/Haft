import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Clock3, FileDiff, RefreshCw, Terminal } from 'lucide-react';
import { RUNTIME_LABELS, type AgentRuntimeType } from '@raft-lite/contracts';
import { useExecution, useExecutionDiff, useExecutionLogs } from '../hooks/use-raft-data';
import { useSocketStatus } from '../providers/socket-provider';
import { useToast } from '../providers/toast-provider';
import { api, ApiError } from '../services/api';
import { queryKeys } from '../services/query-keys';
import { formatDateTime, formatDuration, shortId } from '../lib/utils';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ErrorState, InlineAlert, Skeleton } from '../components/ui/feedback';
import { Avatar } from '../components/ui/avatar';
import { ExecutionStatusBadge, TaskStatusBadge } from '../components/ui/status-badge';
import { LogPanel } from '../features/executions/log-panel';
import { ChangesPanel } from '../features/executions/changes-panel';

export function ExecutionPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const executionQuery = useExecution(id);
  const execution = executionQuery.data;
  const isRunning = execution?.status === 'running';
  const logsQuery = useExecutionLogs(id, Boolean(isRunning));
  const [activeTab, setActiveTab] = useState<'logs' | 'changes'>('logs');
  const diffQuery = useExecutionDiff(id, activeTab === 'changes');
  const socketStatus = useSocketStatus();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);

  async function handleRefresh(): Promise<void> {
    await Promise.all([executionQuery.refetch(), logsQuery.refetch()]);
  }

  async function handleStop(): Promise<void> {
    if (!id) return;
    setStopping(true);
    try {
      await api.cancelExecution(id, { reason: 'Cancelled from execution detail' });
      setStopOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.executions.detail(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.executions.logs(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
      toast({
        title: 'Execution cancelled',
        description: 'The task was cancelled and the agent returned to Idle.',
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: 'Execution could not be cancelled',
        description: error instanceof ApiError ? error.message : 'Please try again.',
        variant: 'error',
      });
    } finally {
      setStopping(false);
    }
  }

  if (executionQuery.isLoading) {
    return (
      <div data-testid="execution-page">
        <div className="mb-4">
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="mb-6 h-[66px] w-[420px] max-w-full" />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.8fr)]" data-testid="execution-loading">
          <Skeleton className="h-[270px] rounded-2xl" />
          <div className="space-y-4">
            <Skeleton className="h-[126px] rounded-2xl" />
            <Skeleton className="h-[126px] rounded-2xl" />
          </div>
        </div>
        <Skeleton className="mt-4 h-[360px] rounded-2xl" />
      </div>
    );
  }

  if (executionQuery.isError || !execution) {
    return (
      <div data-testid="execution-page">
        <Link
          to="/tasks"
          className="mb-4 inline-flex items-center gap-1.5 rounded text-[11.5px] font-medium text-muted hover:text-ink focus-ring"
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Back to tasks
        </Link>
        <ErrorState
          title="Execution could not be loaded"
          description={
            executionQuery.error instanceof Error
              ? executionQuery.error.message
              : 'The execution may have been removed or the API is unavailable.'
          }
          onRetry={() => void executionQuery.refetch()}
          testId="execution-error"
          retryTestId="execution-retry-button"
        />
      </div>
    );
  }

  const runtimeLabel =
    RUNTIME_LABELS[execution.runtime as AgentRuntimeType] ?? execution.runtime;
  const outcomeCopy =
    execution.status === 'running'
      ? `The ${runtimeLabel} runtime is executing this task. Logs stream live over Socket.IO.`
      : execution.status === 'completed'
        ? 'The execution completed and the task moved to Done. The agent is idle.'
        : execution.status === 'failed'
          ? `The execution failed and the agent requires attention.${execution.failureReason ? ` ${execution.failureReason}` : ''}`
          : `The execution was cancelled.${execution.cancelReason ? ` ${execution.cancelReason}` : ''}`;

  return (
    <div data-testid="execution-page">
      <Link
        to="/tasks"
        data-testid="execution-back-link"
        className="mb-4 inline-flex items-center gap-1.5 rounded text-[11.5px] font-medium text-muted transition-colors hover:text-ink focus-ring"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Back to tasks
      </Link>

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-faint">
            <Terminal size={11} aria-hidden="true" />
            Execution {shortId(execution.id)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.035em] text-ink">
              Execution detail
            </h1>
            <ExecutionStatusBadge status={execution.status} />
          </div>
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-5 text-muted">
            {execution.task.title} · {runtimeLabel} runtime
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="icon"
            onClick={() => void handleRefresh()}
            aria-label="Refresh execution"
            title="Refresh execution"
            data-testid="execution-refresh-button"
            loading={executionQuery.isFetching || logsQuery.isFetching}
          >
            {!executionQuery.isFetching && !logsQuery.isFetching ? (
              <RefreshCw size={14} aria-hidden="true" />
            ) : null}
          </Button>
          {isRunning ? (
            <Button
              variant="secondary"
              className="border-danger/30 text-danger hover:bg-danger/[0.06]"
              onClick={() => setStopOpen(true)}
              data-testid="execution-stop-button"
            >
              <Ban size={13} aria-hidden="true" />
              Cancel execution
            </Button>
          ) : null}
        </div>
      </header>

      <div
        className={`mb-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12px] leading-5 ${
          execution.status === 'failed'
            ? 'border-danger/20 bg-[#fbf1ee] text-[#873d2f]'
            : execution.status === 'cancelled'
              ? 'border-line bg-[#f5f3ee] text-muted'
              : execution.status === 'completed'
                ? 'border-success/20 bg-[#eef5f0] text-[#356a4e]'
                : 'border-[#d6e0e8] bg-[#eef3f6] text-[#4f6f8f]'
        }`}
        data-testid="execution-status-banner"
        data-status={execution.status}
        role="status"
      >
        <span
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
            isRunning ? 'animate-pulse bg-current' : 'bg-current'
          }`}
          aria-hidden="true"
        />
        <div>{outcomeCopy}</div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(310px,0.8fr)]">
        <section className="panel p-5" aria-labelledby="progress-title" data-testid="execution-progress-panel">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                Progress
              </p>
              <div className="mt-2 flex items-end gap-2">
                <span
                  className="numeric text-[42px] font-semibold leading-none tracking-[-0.06em] text-ink"
                  data-testid="execution-progress-value"
                >
                  {execution.progress}
                </span>
                <span className="pb-1 text-[14px] font-medium text-faint">%</span>
              </div>
            </div>
            <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-[#f8f6f1] text-muted">
              <Clock3 size={17} aria-hidden="true" />
            </div>
          </div>
          <div
            className="mt-5 h-2 overflow-hidden rounded-full bg-[#ece9e2]"
            role="progressbar"
            aria-label="Execution progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={execution.progress}
            data-testid="execution-progress"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${
                execution.status === 'failed'
                  ? 'bg-danger'
                  : execution.status === 'cancelled'
                    ? 'bg-[#a09a8f]'
                    : 'bg-[#5f7f70]'
              }`}
              style={{ width: `${execution.progress}%` }}
            />
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 text-[11.5px] sm:grid-cols-4">
            <div>
              <dt className="text-faint">Started</dt>
              <dd className="mt-1 font-medium text-ink">{formatDateTime(execution.startedAt)}</dd>
            </div>
            <div>
              <dt className="text-faint">Ended</dt>
              <dd className="mt-1 font-medium text-ink">
                {execution.endedAt ? formatDateTime(execution.endedAt) : 'In progress'}
              </dd>
            </div>
            <div>
              <dt className="text-faint">Duration</dt>
              <dd className="mt-1 font-medium text-ink">
                {formatDuration(execution.startedAt, execution.endedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-faint">Runtime</dt>
              <dd className="mt-1 font-medium text-ink">{runtimeLabel}</dd>
            </div>
          </dl>
          {execution.failureReason ? (
            <div className="mt-4">
              <InlineAlert variant="error" testId="execution-failure-reason">
                {execution.failureReason}
              </InlineAlert>
            </div>
          ) : null}
          {execution.cancelReason ? (
            <div className="mt-4">
              <InlineAlert variant="warning" testId="execution-cancel-reason">
                {execution.cancelReason}
              </InlineAlert>
            </div>
          ) : null}
        </section>

        <div className="space-y-4">
          <section className="panel p-4" aria-labelledby="execution-task-title" data-testid="execution-task-card">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                Task
              </p>
              <TaskStatusBadge status={execution.task.status} />
            </div>
            <h2
              id="execution-task-title"
              className="mt-2.5 text-[13px] font-semibold leading-5 tracking-[-0.01em] text-ink"
            >
              {execution.task.title}
            </h2>
            <p className="mt-1 line-clamp-2 text-[11px] leading-[1.55] text-muted">
              {execution.task.description || 'No description provided.'}
            </p>
            <Link
              to={`/tasks?task=${encodeURIComponent(execution.task.id)}`}
              data-testid="execution-task-link"
              className="mt-3 inline-flex rounded text-[10.5px] font-semibold text-muted hover:text-ink focus-ring"
            >
              Open task
            </Link>
          </section>

          <section className="panel p-4" aria-labelledby="execution-agent-title" data-testid="execution-agent-card">
            <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
              Agent
            </p>
            <div className="mt-2.5 flex items-center gap-2.5">
              <Avatar name={execution.agent.name} />
              <div className="min-w-0">
                <h2 id="execution-agent-title" className="truncate text-[12.5px] font-semibold text-ink">
                  {execution.agent.name}
                </h2>
                <p className="truncate text-[10.5px] text-faint">{execution.agent.role}</p>
              </div>
              <span
                className="ml-auto rounded-full border border-line bg-surface px-2 py-0.5 text-[9.5px] font-medium text-muted"
                data-testid="execution-agent-status"
                data-status={execution.agent.status}
              >
                {execution.agent.status}
              </span>
            </div>
            <div className="mt-3 border-t border-line pt-3 text-[10.5px] text-faint">
              {RUNTIME_LABELS[execution.agent.runtime]} runtime · Execution {shortId(execution.id)}
            </div>
          </section>
        </div>
      </div>

      <div className="mt-4" data-testid="execution-views">
        <div
          className="mb-3 inline-flex rounded-xl border border-line bg-[#f8f6f1] p-1"
          role="tablist"
          aria-label="Execution detail views"
        >
          <button
            type="button"
            role="tab"
            id="execution-logs-tab"
            aria-selected={activeTab === 'logs'}
            aria-controls="execution-logs-panel"
            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors focus-ring ${
              activeTab === 'logs' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
            }`}
            onClick={() => setActiveTab('logs')}
            data-testid="execution-logs-tab"
          >
            <span className="inline-flex items-center gap-1.5">
              <Terminal size={12} aria-hidden="true" />
              Logs
            </span>
          </button>
          <button
            type="button"
            role="tab"
            id="execution-changes-tab"
            aria-selected={activeTab === 'changes'}
            aria-controls="execution-changes-panel"
            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors focus-ring ${
              activeTab === 'changes' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
            }`}
            onClick={() => setActiveTab('changes')}
            data-testid="execution-changes-tab"
          >
            <span className="inline-flex items-center gap-1.5">
              <FileDiff size={12} aria-hidden="true" />
              Changes
              {execution.changedFiles > 0 ? (
                <span className="rounded-full border border-line bg-surface px-1.5 text-[9px] text-muted">
                  {execution.changedFiles}
                </span>
              ) : null}
            </span>
          </button>
        </div>

        {activeTab === 'logs' ? (
          <div
            role="tabpanel"
            id="execution-logs-panel"
            aria-labelledby="execution-logs-tab"
            data-testid="execution-logs-panel"
          >
            <LogPanel
              logs={logsQuery.data?.items ?? []}
              loading={logsQuery.isLoading}
              live={Boolean(isRunning)}
              socketStatus={socketStatus}
              error={logsQuery.isError}
              onRetry={() => void logsQuery.refetch()}
            />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="execution-changes-panel"
            aria-labelledby="execution-changes-tab"
            data-testid="execution-changes-panel"
          >
            <ChangesPanel
              diff={diffQuery.data}
              loading={diffQuery.isLoading || (diffQuery.isFetching && !diffQuery.data)}
              error={diffQuery.isError}
              onRetry={() => void diffQuery.refetch()}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Cancel this execution?"
        description="The running execution will stop once the runtime confirms cancellation. The task moves to Cancelled and the agent returns to Idle."
        confirmLabel="Cancel execution"
        cancelLabel="Keep running"
        onConfirm={() => void handleStop()}
        pending={stopping}
        danger
        testId="execution-stop-dialog"
        confirmTestId="execution-stop-confirm-button"
        cancelTestId="execution-stop-dismiss-button"
      />
    </div>
  );
}
