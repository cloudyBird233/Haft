import { useEffect, useState } from 'react';
import type { ComputerDto, ProjectBindingDto } from '@raft-lite/contracts';
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
import { Input, Select } from '../../components/ui/input';

export interface BindingFormSubmission {
  computerId: string;
  path: string;
}

export function ProjectBindingFormDialog({
  open,
  onOpenChange,
  mode,
  projectName,
  binding,
  computers,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  projectName: string;
  binding?: ProjectBindingDto | null;
  computers: ComputerDto[];
  onSubmit: (values: BindingFormSubmission) => Promise<void>;
}): JSX.Element {
  const [computerId, setComputerId] = useState('');
  const [path, setPath] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setComputerId(binding?.computerId ?? computers[0]?.id ?? '');
    setPath(binding?.path ?? '');
    setErrors({});
    setFormError(null);
    setSubmitting(false);
  }, [open, binding, computers]);

  const dialogTitle = mode === 'create' ? 'Bind repository' : 'Change repository path';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    const nextErrors: Record<string, string> = {};
    if (!computerId) nextErrors.computerId = 'Select a computer';
    if (!path.trim()) nextErrors.path = 'Repository path is required';
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await onSubmit({ computerId, path });
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
        if (Array.isArray(error.details)) {
          const details: Record<string, string> = {};
          for (const detail of error.details) {
            if (detail.path) details[detail.path] = detail.message;
          }
          setErrors(details);
        }
      } else {
        setFormError('Something went wrong while saving the binding.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        testId="binding-form-dialog"
        className="sm:max-w-[560px]"
        ariaLabel={dialogTitle}
      >
        <div className="border-b border-line px-5 py-4">
          <DialogTitle className="pr-8 text-[15px] font-semibold tracking-[-0.02em]">
            {dialogTitle}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] leading-5 text-muted">
            {mode === 'create'
              ? `Choose the computer that can see the repository for ${projectName}. The path is validated by that computer's runner.`
              : 'Changing the path invalidates the previous validation and requires a new runner check.'}
          </DialogDescription>
        </div>
        <form
          onSubmit={handleSubmit}
          noValidate
          data-testid="binding-form"
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
                data-testid="binding-form-error"
                className="rounded-xl border border-danger/20 bg-[#fbf1ee] px-3 py-2.5 text-[12px] leading-5 text-[#873d2f]"
              >
                {formError}
              </div>
            ) : null}
            <Field label="Computer" htmlFor="binding-computer" required error={errors.computerId}>
              <Select
                id="binding-computer"
                name="computerId"
                data-testid="binding-computer-select"
                value={computerId}
                onChange={(event) => setComputerId(event.target.value)}
                disabled={submitting || mode === 'edit' || computers.length === 0}
                aria-invalid={Boolean(errors.computerId)}
              >
                {computers.length === 0 ? <option value="">No computers available</option> : null}
                {computers.map((computer) => (
                  <option key={computer.id} value={computer.id}>
                    {computer.name} · {computer.hostname}
                    {computer.status === 'offline' ? ' (offline)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Absolute repository path"
              htmlFor="binding-path"
              required
              error={errors.path}
              hint="The runner must be able to resolve this path and it must be the root of a Git main worktree."
            >
              <Input
                id="binding-path"
                name="path"
                data-testid="binding-path-input"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/srv/repos/haft or C:\work\haft"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.path)}
                disabled={submitting}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="binding-cancel-button"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              disabled={computers.length === 0}
              data-testid="binding-submit-button"
            >
              {submitting ? 'Saving…' : mode === 'create' ? 'Create binding' : 'Save path'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
