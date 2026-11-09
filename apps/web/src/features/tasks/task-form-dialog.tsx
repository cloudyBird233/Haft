import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentDto, CreateTaskInput, ProjectDto, TaskPriority } from '@raft-lite/contracts';
import { TASK_PRIORITY_LABELS, createTaskSchema } from '@raft-lite/contracts';
import { ApiError } from '../../services/api';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../components/ui/dialog';
import { Field } from '../../components/ui/field';
import { Input, Select, Textarea } from '../../components/ui/input';

export function TaskFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
  projects,
  agents,
  lockAssignment = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  initial?: {
    title: string;
    description: string;
    projectId: string;
    assigneeAgentId: string | null;
    priority: TaskPriority;
  } | null;
  projects: ProjectDto[];
  agents: AgentDto[];
  lockAssignment?: boolean;
  onSubmit: (values: CreateTaskInput) => Promise<void>;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [assigneeAgentId, setAssigneeAgentId] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? '');
    setDescription(initial?.description ?? '');
    setProjectId(initial?.projectId ?? projects[0]?.id ?? '');
    setAssigneeAgentId(initial?.assigneeAgentId ?? '');
    setPriority(initial?.priority ?? 'medium');
    setErrors({});
    setFormError(null);
    setSubmitting(false);
  }, [open, initial, projects]);

  const dialogTitle = mode === 'create' ? 'Create task' : 'Edit task';
  const dialogDescription =
    mode === 'create'
      ? 'Define a unit of work, route it to an agent, and track it on the board.'
      : 'Update the task brief. Assignment and workflow state are managed separately.';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    const submitted = {
      title: title.trim(),
      description: description.trim(),
      projectId,
      assigneeAgentId: assigneeAgentId || null,
      priority,
    };
    const parsed = createTaskSchema.safeParse(submitted);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]?.toString() ?? 'form';
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
        if (Array.isArray(error.details)) {
          const nextErrors: Record<string, string> = {};
          for (const detail of error.details) {
            if (detail.path) nextErrors[detail.path] = detail.message;
          }
          setErrors(nextErrors);
        }
      } else {
        setFormError('Something went wrong while saving the task.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent testId="task-form-dialog" className="sm:max-w-[620px]" ariaLabel={dialogTitle}>
        <div className="border-b border-line px-5 py-4">
          <DialogTitle className="pr-8 text-[15px] font-semibold tracking-[-0.02em]">
            {dialogTitle}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] leading-5 text-muted">
            {dialogDescription}
          </DialogDescription>
        </div>
        <form
          onSubmit={handleSubmit}
          noValidate
          data-testid="task-form"
          data-state={
            submitting
              ? 'submitting'
              : formError || Object.keys(errors).length > 0
                ? 'error'
                : 'idle'
          }
        >
          <DialogBody className="space-y-4">
            {formError ? (
              <div
                role="alert"
                data-testid="task-form-error"
                className="rounded-xl border border-danger/20 bg-[#fbf1ee] px-3 py-2.5 text-[12px] leading-5 text-[#873d2f]"
              >
                {formError}
              </div>
            ) : null}
            <Field label="Title" htmlFor="task-title" required error={errors.title}>
              <Input
                id="task-title"
                name="title"
                data-testid="task-title-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What should be delivered?"
                autoComplete="off"
                aria-invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? 'task-title-error' : undefined}
                disabled={submitting}
                autoFocus
              />
            </Field>
            <Field label="Description" htmlFor="task-description" error={errors.description}>
              <Textarea
                id="task-description"
                name="description"
                data-testid="task-description-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Context, acceptance criteria, and constraints…"
                disabled={submitting}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project" htmlFor="task-project" required error={errors.projectId}>
                <Select
                  id="task-project"
                  name="projectId"
                  data-testid="task-project-select"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  disabled={submitting || projects.length === 0}
                  aria-invalid={Boolean(errors.projectId)}
                >
                  {projects.length === 0 ? <option value="">No projects available</option> : null}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
                {projects.length === 0 ? (
                  <p
                    className="mt-1.5 text-[11.5px] leading-4 text-faint"
                    data-testid="task-form-no-projects"
                  >
                    No active projects are available.{' '}
                    <Link
                      to="/projects"
                      className="font-semibold text-muted underline-offset-2 hover:text-ink hover:underline"
                    >
                      Create a project
                    </Link>{' '}
                    before creating a task.
                  </p>
                ) : null}
              </Field>
              <Field
                label="Assignee"
                htmlFor="task-assignee"
                hint={
                  lockAssignment
                    ? 'Assignment is fixed for completed or cancelled tasks.'
                    : 'Optional. Assign now or from task detail.'
                }
              >
                <Select
                  id="task-assignee"
                  name="assigneeAgentId"
                  data-testid="task-assignee-select"
                  value={assigneeAgentId}
                  onChange={(event) => setAssigneeAgentId(event.target.value)}
                  disabled={submitting || lockAssignment}
                >
                  <option value="">Unassigned</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.role}
                      {agent.status === 'offline' ? ' (offline)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Priority" htmlFor="task-priority" required error={errors.priority}>
              <Select
                id="task-priority"
                name="priority"
                data-testid="task-priority-select"
                value={priority}
                onChange={(event) => setPriority(event.target.value as TaskPriority)}
                disabled={submitting}
              >
                {(Object.keys(TASK_PRIORITY_LABELS) as TaskPriority[]).map((key) => (
                  <option key={key} value={key}>
                    {TASK_PRIORITY_LABELS[key]}
                  </option>
                ))}
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="task-cancel-button"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              data-testid="task-submit-button"
              disabled={projects.length === 0}
            >
              {submitting ? 'Saving…' : mode === 'create' ? 'Create task' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
