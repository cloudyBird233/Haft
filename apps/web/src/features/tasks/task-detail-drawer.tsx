import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentDto, TaskDetailDto, TaskStatus } from '@raft-lite/contracts';
import {
  TASK_STATUS_LABELS,
  TASK_STATUS_TRANSITIONS,
  isTerminalTaskStatus,
} from '@raft-lite/contracts';
import {
  ArrowUpRight,
  Ban,
  Clock3,
  Play,
  RotateCcw,
  Trash2,
  UserRound,
} from 'lucide-react';
import { api, ApiError } from '../../services/api';
import { queryKeys } from '../../services/query-keys';
import { useTask } from '../../hooks/use-raft-data';
import { useToast } from '../../providers/toast-provider';
import { formatDate, formatDuration, formatShortDateTime } from '../../lib/utils';
import { Avatar } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog';
import { EmptyState, ErrorState } from '../../components/ui/feedback';
import { Label } from '../../components/ui/field';
import { Select } from '../../components/ui/input';
import { ExecutionStatusBadge, PriorityBadge, TaskStatusBadge } from '../../components/ui/status-badge';

type PendingAction = 'status' | 'assign' | 'start' | 'cancel' | 'delete' | null;

function actionError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The action could not be completed.';
}

export function TaskDetailDrawer({
  taskId,
  open,
  onOpenChange,
  agents,
  onEdit,
  onDeleted,
}: {
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentDto[];
  onEdit: (task: TaskDetailDto) => void;
  onDeleted: () => void;
}): JSX.Element {
  const query = useTask(taskId);
  const task = query.data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [nextStatus, setNextStatus] = useState<TaskStatus | ''>('');
  const [assigneeId, setAssigneeId] = useState('');
  const [pending, setPending] = useState<PendingAction>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!task) return;
    setAssigneeId(task.assignee?.id ?? '');
    setNextStatus('');
  }, [task?.id, task?.status, task?.assignee?.id]);

  useEffect(() => {
    if (!open) {
      setCancelOpen(false);
      setDeleteOpen(false);
    }
  }, [open]);

  const activeExecution = task?.latestExecution?.status === 'running';
  const allowedTransitions = task ? TASK_STATUS_TRANSITIONS[task.status] : [];
  const assignee = task?.assignee;
  const paused =
    !task ||
    activeExecution ||
    !assignee ||
    isTerminalTaskStatus(task.status) ||
    !['todo', 'claimed', 'in_progress'].includes(task.status) ||
    assignee.status === 'offline' ||
    assignee.status === 'error' ||
    assignee.status === 'busy' ||
    assignee.runtime !== 'mock';

  const startBlockedReason = !task
    ? 'Task not loaded'
    : activeExecution
      ? 'An execution is already running for this task'
      : !assignee
        ? 'Assign an agent before starting execution'
        : isTerminalTaskStatus(task.status) || !['todo', 'claimed', 'in_progress'].includes(task.status)
          ? 'Only todo, claimed, or in-progress tasks can start'
          : assignee.status === 'offline'
            ? 'The assigned agent is offline'
            : assignee.status === 'error'
              ? 'Reset the assigned agent to Idle first'
              : assignee.status === 'busy'
                ? 'The assigned agent is busy'
                : assignee.runtime !== 'mock'
                  ? 'This runtime adapter is not connected'
                  : null;

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    if (taskId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    void queryClient.invalidateQueries({ queryKey: ['activities'] });
  }

  async function handleStatusUpdate(): Promise<void> {
    if (!task || !nextStatus) return;
    setPending('status');
    try {
      await api.updateTask(task.id, { status: nextStatus });
      toast({
        title: 'Task status updated',
        description: `Moved to ${TASK_STATUS_LABELS[nextStatus]}.`,
        variant: 'success',
      });
      setNextStatus('');
      invalidate();
    } catch (error) {
      toast({ title: 'Status update failed', description: actionError(error), variant: 'error' });
    } finally {
      setPending(null);
    }
  }

  async function handleAssignment(): Promise<void> {
    if (!task) return;
    setPending('assign');
    try {
      await api.assignTask(task.id, { agentId: assigneeId || null });
      toast({
        title: 'Assignment saved',
        description: assigneeId ? 'The agent is now responsible for this task.' : 'The task is now unassigned.',
        variant: 'success',
      });
      invalidate();
    } catch (error) {
      toast({ title: 'Assignment failed', description: actionError(error), variant: 'error' });
    } finally {
      setPending(null);
    }
  }

  async function handleStart(): Promise<void> {
    if (!task) return;
    setPending('start');
    try {
      const execution = await api.startTask(task.id);
      invalidate();
      onOpenChange(false);
      toast({
        title: 'Execution started',
        description: 'The mock runtime is now working on this task.',
        variant: 'success',
      });
      navigate(`/executions/${execution.id}`);
    } catch (error) {
      toast({ title: 'Execution could not start', description: actionError(error), variant: 'error' });
    } finally {
      setPending(null);
    }
  }

  async function handleCancel(): Promise<void> {
    if (!task) return;
    setPending('cancel');
    try {
      await api.cancelTask(task.id, { reason: 'Cancelled from task detail' });
      setCancelOpen(false);
      toast({ title: 'Task cancelled', variant: 'success' });
      invalidate();
    } catch (error) {
      toast({ title: 'Task could not be cancelled', description: actionError(error), variant: 'error' });
    } finally {
      setPending(null);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!task) return;
    setPending('delete');
    try {
      await api.deleteTask(task.id);
      setDeleteOpen(false);
      onOpenChange(false);
      onDeleted();
      toast({ title: 'Task deleted', variant: 'success' });
      invalidate();
    } catch (error) {
      toast({ title: 'Task could not be deleted', description: actionError(error), variant: 'error' });
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          side="drawer"
          testId="task-detail-panel"
          ariaLabel={task ? `Task details for ${task.title}` : 'Task details'}
          className="sm:w-[520px]"
        >
          <div className="flex-1 overflow-y-auto">
            <div className="border-b border-line bg-[#fbfaf7] px-5 pb-4 pt-5 pr-14">
              <p className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.15em] text-faint">
                {task ? `${task.project.key} · Task ${task.id.slice(-6).toUpperCase()}` : 'Task detail'}
              </p>
              {task ? (
                <>
                  <DialogTitle className="text-[18px] font-semibold leading-6 tracking-[-0.025em] text-ink">
                    {task.title}
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-[11.5px] text-muted">
                    {task.project.name} · Created {formatDate(task.createdAt)}
                  </DialogDescription>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <TaskStatusBadge status={task.status} />
                    <PriorityBadge priority={task.priority} />
                    {activeExecution ? (
                      <span className="text-[10.5px] font-medium text-success">Live execution</span>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <DialogTitle className="text-[18px] font-semibold text-ink">Task details</DialogTitle>
                  <DialogDescription className="sr-only">Loading task details.</DialogDescription>
                </>
              )}
            </div>

            {query.isLoading ? (
              <div className="flex min-h-[340px] items-center justify-center" role="status">
                <span className="text-[12px] text-muted">Loading task…</span>
              </div>
            ) : query.isError && query.error instanceof ApiError && query.error.status === 404 ? (
              <div className="p-5">
                <EmptyState
                  title="Task not found"
                  description="This task may have been deleted."
                  testId="task-detail-not-found"
                />
              </div>
            ) : query.isError ? (
              <div className="p-5">
                <ErrorState
                  title="Task could not be loaded"
                  description={query.error instanceof Error ? query.error.message : 'Please try again.'}
                  onRetry={() => void query.refetch()}
                  testId="task-detail-error"
                  retryTestId="task-detail-retry-button"
                />
              </div>
            ) : task ? (
              <div className="space-y-6 px-5 py-5">
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                    Brief
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-5 text-muted">
                    {task.description || 'No description provided.'}
                  </p>
                </section>

                <section className="rounded-xl border border-line bg-[#fbfaf7] p-3.5">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                    Details
                  </h3>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[11.5px]">
                    <div>
                      <dt className="text-faint">Project</dt>
                      <dd className="mt-0.5 font-medium text-ink">{task.project.name}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">Assignee</dt>
                      <dd className="mt-0.5 flex items-center gap-1.5 font-medium text-ink">
                        {task.assignee ? (
                          <>
                            <Avatar name={task.assignee.name} size="sm" />
                            {task.assignee.name}
                          </>
                        ) : (
                          <span className="text-faint">Unassigned</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-faint">Updated</dt>
                      <dd className="mt-0.5 font-medium text-ink">{formatShortDateTime(task.updatedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">Executions</dt>
                      <dd className="mt-0.5 font-medium text-ink">{task.executionCount}</dd>
                    </div>
                  </dl>
                </section>

                <section className="rounded-xl border border-line p-3.5">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                    Workflow
                  </h3>
                  {activeExecution ? (
                    <p className="mt-2.5 rounded-lg bg-accent-soft px-2.5 py-2 text-[11px] leading-4 text-[#456454]">
                      Workflow state is being managed by the active execution. Cancel the run to stop it.
                    </p>
                  ) : allowedTransitions.length > 0 ? (
                    <div className="mt-3 space-y-2.5">
                      <Label htmlFor="task-next-status">Next status</Label>
                      <div className="flex items-center gap-2">
                        <Select
                          id="task-next-status"
                          data-testid="task-status-select"
                          value={nextStatus}
                          onChange={(event) => setNextStatus(event.target.value as TaskStatus | '')}
                          disabled={pending !== null}
                          aria-label="Task status"
                        >
                          <option value="">Choose a status…</option>
                          {allowedTransitions.map((status) => (
                            <option key={status} value={status}>
                              {TASK_STATUS_LABELS[status]}
                            </option>
                          ))}
                        </Select>
                        <Button
                          size="md"
                          variant="secondary"
                          className="shrink-0"
                          onClick={() => void handleStatusUpdate()}
                          loading={pending === 'status'}
                          disabled={!nextStatus || pending !== null}
                          data-testid="task-status-update-button"
                        >
                          Update status
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2.5 text-[11.5px] text-faint">
                      This task is in a terminal state. No manual transitions are available.
                    </p>
                  )}
                  <div className="mt-3 border-t border-line pt-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <Label htmlFor="task-assignee-detail" className="mb-0">
                        Assigned agent
                      </Label>
                      <UserRound size={12} className="text-faint" aria-hidden="true" />
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        id="task-assignee-detail"
                        data-testid="task-assignee-detail-select"
                        value={assigneeId}
                        onChange={(event) => setAssigneeId(event.target.value)}
                        disabled={pending !== null || activeExecution}
                        aria-label="Assigned agent"
                      >
                        <option value="">Unassigned</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name} · {agent.role}
                            {agent.status === 'offline' ? ' (offline)' : ''}
                          </option>
                        ))}
                      </Select>
                      <Button
                        variant="secondary"
                        className="shrink-0"
                        onClick={() => void handleAssignment()}
                        loading={pending === 'assign'}
                        disabled={pending !== null || activeExecution}
                        data-testid="task-assign-button"
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                  {!isTerminalTaskStatus(task.status) ? (
                    <div className="mt-3 border-t border-line pt-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-danger hover:bg-danger/[0.06] hover:text-danger"
                        onClick={() => setCancelOpen(true)}
                        disabled={pending !== null}
                        data-testid="task-cancel-button"
                      >
                        <Ban size={12} aria-hidden="true" />
                        Cancel task
                      </Button>
                    </div>
                  ) : null}
                </section>

                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                    Execution
                  </h3>
                  {task.latestExecution ? (
                    <div className="mt-2.5 rounded-xl border border-line bg-panel p-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <ExecutionStatusBadge status={task.latestExecution.status} />
                          <span className="text-[10.5px] text-faint">
                            {task.latestExecution.progress}%
                          </span>
                        </div>
                        <Link
                          to={`/executions/${task.latestExecution.id}`}
                          onClick={() => onOpenChange(false)}
                          data-testid="task-execution-link"
                          className="inline-flex items-center gap-1 rounded text-[10.5px] font-medium text-muted hover:text-ink focus-ring"
                        >
                          Open run
                          <ArrowUpRight size={11} aria-hidden="true" />
                        </Link>
                      </div>
                      <div
                        className="mt-2.5 h-1 overflow-hidden rounded-full bg-line"
                        role="progressbar"
                        aria-label="Latest execution progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={task.latestExecution.progress}
                      >
                        <div
                          className="h-full rounded-full bg-[#5f7f70] transition-[width] duration-500"
                          style={{ width: `${task.latestExecution.progress}%` }}
                        />
                      </div>
                      <div className="mt-2 flex items-center gap-3 text-[10px] text-faint">
                        <span className="inline-flex items-center gap-1">
                          <Clock3 size={10} aria-hidden="true" />
                          {formatDuration(task.latestExecution.startedAt, task.latestExecution.endedAt)}
                        </span>
                        <span>Started {formatShortDateTime(task.latestExecution.startedAt)}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2.5 rounded-xl border border-dashed border-line-strong px-3 py-4 text-[11.5px] text-faint">
                      No execution has been started for this task.
                    </p>
                  )}
                  <div className="mt-3">
                    <Button
                      variant="primary"
                      className="w-full"
                      onClick={() => void handleStart()}
                      loading={pending === 'start'}
                      disabled={paused || pending !== null}
                      title={startBlockedReason ?? 'Start a deterministic Mock execution'}
                      data-testid="execution-start-button"
                    >
                      <Play size={13} aria-hidden="true" />
                      Start execution
                    </Button>
                    {startBlockedReason ? (
                      <p className="mt-2 text-center text-[10.5px] text-faint" data-testid="execution-start-hint">
                        {startBlockedReason}
                      </p>
                    ) : (
                      <p className="mt-2 text-center text-[10.5px] text-faint">
                        Runs with the deterministic Mock runtime.
                      </p>
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                    Execution history
                  </h3>
                  {task.executions.length > 0 ? (
                    <div className="mt-2 divide-y divide-line rounded-xl border border-line" data-testid="task-execution-history">
                      {task.executions.map((execution) => (
                        <Link
                          key={execution.id}
                          to={`/executions/${execution.id}`}
                          onClick={() => onOpenChange(false)}
                          data-testid="task-execution-row"
                          className="flex items-center justify-between gap-3 px-3 py-3 first:rounded-t-xl last:rounded-b-xl hover:bg-surface focus-ring"
                        >
                          <div>
                            <p className="text-[11.5px] font-medium text-ink">
                              {execution.runtime} · {execution.progress}%
                            </p>
                            <p className="mt-0.5 text-[10px] text-faint">
                              {formatShortDateTime(execution.startedAt)}
                            </p>
                          </div>
                          <ExecutionStatusBadge status={execution.status} />
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="No executions yet"
                      description="Start a run to see its progress and logs here."
                      className="mt-2 min-h-[120px] py-6"
                      testId="task-execution-empty"
                    />
                  )}
                </section>
              </div>
            ) : (
              <div className="p-5">
                <EmptyState
                  title="Task not found"
                  description="This task may have been deleted."
                  testId="task-detail-not-found"
                />
              </div>
            )}
          </div>

          {task ? (
            <div className="flex items-center gap-2 border-t border-line bg-[#fcfbf8] px-5 py-3.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete task"
                title={activeExecution ? 'Cancel the execution before deleting' : 'Delete task'}
                onClick={() => setDeleteOpen(true)}
                disabled={activeExecution || pending !== null}
                data-testid="task-delete-button"
                className="text-danger hover:bg-danger/[0.06] hover:text-danger"
              >
                <Trash2 size={15} aria-hidden="true" />
              </Button>
              <Button
                variant="secondary"
                className="ml-auto"
                onClick={() => onEdit(task)}
                disabled={pending !== null}
                data-testid="task-edit-button"
              >
                <RotateCcw size={13} aria-hidden="true" />
                Edit
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this task?"
        description={
          <>
            “{task?.title}” will move to <strong>Cancelled</strong>. Any active Mock execution
            will stop and the assigned agent will return to Idle.
          </>
        }
        confirmLabel="Cancel task"
        cancelLabel="Keep task"
        onConfirm={() => void handleCancel()}
        pending={pending === 'cancel'}
        danger
        testId="task-cancel-dialog"
        confirmTestId="task-cancel-confirm-button"
        cancelTestId="task-cancel-dismiss-button"
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this task?"
        description="The task and its execution history will be removed. This action cannot be undone."
        confirmLabel="Delete task"
        onConfirm={() => void handleDelete()}
        pending={pending === 'delete'}
        danger
        testId="task-delete-dialog"
        confirmTestId="task-delete-confirm-button"
        cancelTestId="task-delete-dismiss-button"
      />
    </>
  );
}
