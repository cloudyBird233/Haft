import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type {
  CreateTaskInput,
  TaskDetailDto,
  TaskListQuery,
  TaskPriority,
  TaskStatus,
} from '@raft-lite/contracts';
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
} from '@raft-lite/contracts';
import { Plus, Search, X } from 'lucide-react';
import { useAgents, useProjects, useTasks } from '../hooks/use-raft-data';
import { api } from '../services/api';
import { queryKeys } from '../services/query-keys';
import { useToast } from '../providers/toast-provider';
import { Button } from '../components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/feedback';
import { Input, Select } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { TaskBoard } from '../features/tasks/task-board';
import { TaskDetailDrawer } from '../features/tasks/task-detail-drawer';
import { TaskFormDialog } from '../features/tasks/task-form-dialog';
import { isTerminalTaskStatus } from '@raft-lite/contracts';

export function TasksPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskId = searchParams.get('task');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [assignee, setAssignee] = useState('');
  const [projectId, setProjectId] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskDetailDto | null>(null);

  const agentsQuery = useAgents({ limit: 100 });
  const projectsQuery = useProjects();
  const agents = agentsQuery.data?.items ?? [];
  const projects = projectsQuery.data?.items ?? [];
  const selectableProjects = projects.filter(
    (project) =>
      !project.archivedAt || (editingTask ? project.id === editingTask.projectId : false),
  );

  const filters: TaskListQuery = useMemo(
    () => ({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(assignee ? { assigneeAgentId: assignee } : {}),
      ...(projectId ? { projectId } : {}),
      limit: 200,
    }),
    [search, status, priority, assignee, projectId],
  );
  const tasksQuery = useTasks(filters);
  const tasks = tasksQuery.data?.items ?? [];
  const hasFilters = Boolean(search.trim() || status || priority || assignee || projectId);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setEditingTask(null);
      setFormOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  function setSelectedTask(taskId: string | null): void {
    const next = new URLSearchParams(searchParams);
    if (taskId) {
      next.set('task', taskId);
    } else {
      next.delete('task');
    }
    setSearchParams(next, { replace: true });
  }

  function invalidateTasks(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    void queryClient.invalidateQueries({ queryKey: ['activities'] });
  }

  function openCreate(): void {
    setEditingTask(null);
    setFormOpen(true);
  }

  function openEdit(task: TaskDetailDto): void {
    setSelectedTask(null);
    setEditingTask(task);
    setFormOpen(true);
  }

  async function handleFormSubmit(values: CreateTaskInput): Promise<void> {
    if (editingTask) {
      await api.updateTask(editingTask.id, {
        title: values.title,
        description: values.description,
        projectId: values.projectId,
        priority: values.priority,
      });
      const nextAssignee = values.assigneeAgentId ?? null;
      const currentAssignee = editingTask.assignee?.id ?? null;
      if (nextAssignee !== currentAssignee && !isTerminalTaskStatus(editingTask.status)) {
        await api.assignTask(editingTask.id, { agentId: nextAssignee });
      }
      invalidateTasks();
      toast({
        title: 'Task updated',
        description: 'The task brief has been saved.',
        variant: 'success',
      });
    } else {
      const created = await api.createTask(values);
      invalidateTasks();
      setSearch('');
      setStatus('');
      setPriority('');
      setAssignee('');
      setProjectId('');
      toast({
        title: 'Task created',
        description: `“${created.title}” is now on the board.`,
        variant: 'success',
      });
    }
  }

  function clearFilters(): void {
    setSearch('');
    setStatus('');
    setPriority('');
    setAssignee('');
    setProjectId('');
  }

  return (
    <div data-testid="tasks-page">
      <PageHeader
        eyebrow="Workspace"
        title="Tasks"
        description="Plan work, route it to agents, and follow each execution from Todo to done."
        testId="tasks-header"
        actions={
          <Button variant="primary" onClick={openCreate} data-testid="task-create-button">
            <Plus size={14} aria-hidden="true" />
            New task
          </Button>
        }
      />

      <div className="panel mb-4 flex flex-col gap-2 p-2.5 xl:flex-row xl:items-center">
        <div className="relative min-w-0 flex-1 xl:max-w-[320px]">
          <label htmlFor="task-search" className="sr-only">
            Search tasks
          </label>
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            id="task-search"
            type="search"
            data-testid="task-search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks by title or description"
            className="pl-8"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="task-status-filter" className="sr-only">
            Filter tasks by status
          </label>
          <Select
            id="task-status-filter"
            data-testid="task-status-filter"
            value={status}
            onChange={(event) => setStatus(event.target.value as TaskStatus | '')}
            className="w-[136px]"
            aria-label="Status filter"
          >
            <option value="">All statuses</option>
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TASK_STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
          <label htmlFor="task-priority-filter" className="sr-only">
            Filter tasks by priority
          </label>
          <Select
            id="task-priority-filter"
            data-testid="task-priority-filter"
            value={priority}
            onChange={(event) => setPriority(event.target.value as TaskPriority | '')}
            className="w-[128px]"
            aria-label="Priority filter"
          >
            <option value="">All priorities</option>
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {TASK_PRIORITY_LABELS[value]}
              </option>
            ))}
          </Select>
          <label htmlFor="task-assignee-filter" className="sr-only">
            Filter tasks by assignee
          </label>
          <Select
            id="task-assignee-filter"
            data-testid="task-assignee-filter"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
            className="w-[146px]"
            aria-label="Assignee filter"
          >
            <option value="">All assignees</option>
            <option value="unassigned">Unassigned</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
          <label htmlFor="task-project-filter" className="sr-only">
            Filter tasks by project
          </label>
          <Select
            id="task-project-filter"
            data-testid="task-project-filter"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="w-[132px]"
            aria-label="Project filter"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </Select>
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              data-testid="task-clear-filters-button"
            >
              <X size={12} aria-hidden="true" />
              Clear
            </Button>
          ) : null}
        </div>
        <div
          className="ml-auto hidden shrink-0 text-[10.5px] text-faint xl:block"
          data-testid="tasks-count"
        >
          {tasksQuery.data ? `${tasksQuery.data.total} tasks` : ''}
        </div>
      </div>

      {tasksQuery.isLoading ? (
        <div
          className="grid grid-cols-5 gap-3 overflow-hidden"
          role="status"
          aria-label="Loading task board"
          data-testid="tasks-loading"
        >
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="rounded-2xl border border-line bg-[#f8f7f3]/75 p-2">
              <Skeleton className="mb-2 h-5 w-20" />
              <div className="space-y-2">
                <Skeleton className="h-[150px] rounded-xl" />
                <Skeleton className="h-[150px] rounded-xl" />
              </div>
            </div>
          ))}
        </div>
      ) : tasksQuery.isError ? (
        <ErrorState
          title="Tasks could not be loaded"
          description={
            tasksQuery.error instanceof Error
              ? tasksQuery.error.message
              : 'The task board request failed.'
          }
          onRetry={() => void tasksQuery.refetch()}
          testId="tasks-error"
          retryTestId="tasks-retry-button"
        />
      ) : tasks.length === 0 ? (
        hasFilters ? (
          <EmptyState
            title="No tasks match those filters"
            description="Adjust the search or clear the filters to see more work."
            testId="tasks-filter-empty"
            action={
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="The board is clear"
            description="Create a task, assign an agent, and start the first execution."
            testId="tasks-empty"
            action={
              <Button
                variant="primary"
                onClick={openCreate}
                data-testid="tasks-empty-create-button"
              >
                <Plus size={14} aria-hidden="true" />
                Create task
              </Button>
            }
          />
        )
      ) : (
        <TaskBoard tasks={tasks} onOpen={setSelectedTask} />
      )}

      <TaskDetailDrawer
        taskId={selectedTaskId}
        open={Boolean(selectedTaskId)}
        onOpenChange={(open) => {
          if (!open) setSelectedTask(null);
        }}
        agents={agents}
        onEdit={openEdit}
        onDeleted={() => setSelectedTask(null)}
      />

      <TaskFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingTask(null);
        }}
        mode={editingTask ? 'edit' : 'create'}
        initial={
          editingTask
            ? {
                title: editingTask.title,
                description: editingTask.description,
                projectId: editingTask.projectId,
                assigneeAgentId: editingTask.assignee?.id ?? null,
                priority: editingTask.priority,
              }
            : null
        }
        projects={selectableProjects}
        agents={agents}
        lockAssignment={editingTask ? isTerminalTaskStatus(editingTask.status) : false}
        onSubmit={handleFormSubmit}
      />
    </div>
  );
}
