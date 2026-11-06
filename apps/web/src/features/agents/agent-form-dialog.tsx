import { useEffect, useState } from 'react';
import type {
  AgentRuntimeType,
  AgentStatus,
  ComputerDto,
  CreateAgentInput,
  UpdateAgentInput,
} from '@raft-lite/contracts';
import {
  AGENT_STATUS_LABELS,
  RUNTIME_LABELS,
  createAgentSchema,
} from '@raft-lite/contracts';
import { ApiError } from '../../services/api';
import { Field } from '../../components/ui/field';
import { Input, Select, Textarea } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../components/ui/dialog';

export interface AgentFormSubmission {
  name: string;
  role: string;
  description: string;
  runtime: AgentRuntimeType;
  computerId: string | null;
  status?: AgentStatus;
}

const editableStatuses: AgentStatus[] = ['idle', 'offline', 'error'];

export function AgentFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
  computers,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  initial?: {
    name: string;
    role: string;
    description: string;
    runtime: AgentRuntimeType;
    computerId: string | null;
    status: AgentStatus;
  } | null;
  computers: ComputerDto[];
  onSubmit: (values: AgentFormSubmission) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [runtime, setRuntime] = useState<AgentRuntimeType>('mock');
  const [computerId, setComputerId] = useState('');
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setRole(initial?.role ?? '');
    setDescription(initial?.description ?? '');
    setRuntime(initial?.runtime ?? 'mock');
    setComputerId(initial?.computerId ?? computers[0]?.id ?? '');
    setStatus(initial?.status === 'busy' ? 'idle' : (initial?.status ?? 'idle'));
    setErrors({});
    setFormError(null);
    setSubmitting(false);
  }, [open, initial, computers]);

  const dialogTitle = mode === 'create' ? 'Create agent' : 'Edit agent';
  const dialogDescription =
    mode === 'create'
      ? 'Add an AI worker to this workspace. Mock runtime executions are available immediately.'
      : 'Update how this agent appears and which runtime it targets.';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    const candidate = {
      name: name.trim(),
      role: role.trim(),
      description: description.trim(),
      runtime,
      computerId: computerId || null,
    };
    const parsed = createAgentSchema.safeParse(candidate);
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
      await onSubmit({
        ...(parsed.data as CreateAgentInput),
        ...(mode === 'edit' ? { status } : {}),
      });
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
        setFormError('Something went wrong while saving the agent.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent testId="agent-form-dialog" className="sm:max-w-[600px]" ariaLabel={dialogTitle}>
        <div className="border-b border-line px-5 py-4">
          <DialogTitle className="pr-8 text-[15px] font-semibold tracking-[-0.02em]">
            {dialogTitle}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] leading-5 text-muted">
            {dialogDescription}
          </DialogDescription>
        </div>
        <form onSubmit={handleSubmit} noValidate data-testid="agent-form" data-state={submitting ? 'submitting' : formError || Object.keys(errors).length > 0 ? 'error' : 'idle'}>
          <DialogBody className="space-y-4">
            {formError ? (
              <div
                role="alert"
                data-testid="agent-form-error"
                className="rounded-xl border border-danger/20 bg-[#fbf1ee] px-3 py-2.5 text-[12px] leading-5 text-[#873d2f]"
              >
                {formError}
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="agent-name" required error={errors.name}>
                <Input
                  id="agent-name"
                  name="name"
                  data-testid="agent-name-input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Reviewer"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'agent-name-error' : undefined}
                  disabled={submitting}
                  autoFocus
                />
              </Field>
              <Field label="Role" htmlFor="agent-role" required error={errors.role}>
                <Input
                  id="agent-role"
                  name="role"
                  data-testid="agent-role-input"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder="e.g. Security Reviewer"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.role)}
                  aria-describedby={errors.role ? 'agent-role-error' : undefined}
                  disabled={submitting}
                />
              </Field>
            </div>
            <Field label="Description" htmlFor="agent-description" error={errors.description}>
              <Textarea
                id="agent-description"
                name="description"
                data-testid="agent-description-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What does this agent own?"
                aria-invalid={Boolean(errors.description)}
                disabled={submitting}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Runtime"
                htmlFor="agent-runtime"
                required
                error={errors.runtime}
                hint={
                  runtime === 'mock'
                    ? 'Mock runtime is available in Phase 1.'
                    : 'Reserved adapter. Executions are disabled until connected.'
                }
              >
                <Select
                  id="agent-runtime"
                  name="runtime"
                  data-testid="agent-runtime-select"
                  value={runtime}
                  onChange={(event) => setRuntime(event.target.value as AgentRuntimeType)}
                  disabled={submitting}
                >
                  {(Object.keys(RUNTIME_LABELS) as AgentRuntimeType[]).map((key) => (
                    <option key={key} value={key}>
                      {RUNTIME_LABELS[key]}
                      {key === 'mock' ? '' : ' (not connected)'}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Computer" htmlFor="agent-computer" error={errors.computerId}>
                <Select
                  id="agent-computer"
                  name="computerId"
                  data-testid="agent-computer-select"
                  value={computerId}
                  onChange={(event) => setComputerId(event.target.value)}
                  disabled={submitting}
                >
                  <option value="">No computer</option>
                  {computers.map((computer) => (
                    <option key={computer.id} value={computer.id}>
                      {computer.name} ({computer.status})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {mode === 'edit' ? (
              <Field
                label="Status"
                htmlFor="agent-status"
                hint="Busy is assigned automatically while an execution is running."
              >
                <Select
                  id="agent-status"
                  name="status"
                  data-testid="agent-status-select"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as AgentStatus)}
                  disabled={submitting}
                >
                  {editableStatuses.map((key) => (
                    <option key={key} value={key}>
                      {AGENT_STATUS_LABELS[key]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="agent-cancel-button"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              data-testid="agent-submit-button"
            >
              {submitting ? 'Saving…' : mode === 'create' ? 'Create agent' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type AgentMutationInput = CreateAgentInput | UpdateAgentInput;
