import { useEffect, useState } from 'react';
import type { ProjectDto } from '@raft-lite/contracts';
import { createProjectSchema, updateProjectSchema } from '@raft-lite/contracts';
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
import { Input, Textarea } from '../../components/ui/input';

export interface ProjectFormSubmission {
  key: string;
  name: string;
  description: string;
  color: string;
  repoUrl: string | null;
  defaultBranch: string;
}

export function ProjectFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  initial?: ProjectDto | null;
  onSubmit: (values: ProjectFormSubmission) => Promise<void>;
}): JSX.Element {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#6b7280');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey(initial?.key ?? '');
    setName(initial?.name ?? '');
    setDescription(initial?.description ?? '');
    setColor(initial?.color ?? '#6b7280');
    setRepoUrl(initial?.repoUrl ?? '');
    setDefaultBranch(initial?.defaultBranch ?? 'main');
    setErrors({});
    setFormError(null);
    setSubmitting(false);
  }, [open, initial]);

  const dialogTitle = mode === 'create' ? 'Create project' : 'Edit project';
  const dialogDescription =
    mode === 'create'
      ? 'A project groups tasks, executions, and repository bindings under one key.'
      : 'Update project metadata. The project key is immutable; repository bindings change separately.';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    const common = {
      name: name.trim(),
      description: description.trim(),
      color: color.trim(),
      repoUrl: repoUrl.trim() || null,
      defaultBranch: defaultBranch.trim(),
    };
    const parsed =
      mode === 'create'
        ? createProjectSchema.safeParse({ key: key.trim(), ...common })
        : updateProjectSchema.safeParse(common);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]?.toString() ?? 'form';
        if (!nextErrors[field]) nextErrors[field] = issue.message;
      }
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await onSubmit({
        key: mode === 'create' && 'key' in parsed.data ? (parsed.data.key as string) : key,
        ...common,
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
        setFormError('Something went wrong while saving the project.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        testId="project-form-dialog"
        className="sm:max-w-[600px]"
        ariaLabel={dialogTitle}
      >
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
          data-testid="project-form"
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
                data-testid="project-form-error"
                className="rounded-xl border border-danger/20 bg-[#fbf1ee] px-3 py-2.5 text-[12px] leading-5 text-[#873d2f]"
              >
                {formError}
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
              <Field label="Key" htmlFor="project-key" required error={errors.key}>
                <Input
                  id="project-key"
                  name="key"
                  data-testid="project-key-input"
                  value={key}
                  onChange={(event) => setKey(event.target.value.toUpperCase())}
                  placeholder="HAFT"
                  autoComplete="off"
                  maxLength={12}
                  aria-invalid={Boolean(errors.key)}
                  disabled={submitting || mode === 'edit'}
                />
              </Field>
              <Field label="Name" htmlFor="project-name" required error={errors.name}>
                <Input
                  id="project-name"
                  name="name"
                  data-testid="project-name-input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Haft Platform"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.name)}
                  disabled={submitting}
                  autoFocus={mode === 'edit'}
                />
              </Field>
            </div>
            <Field label="Description" htmlFor="project-description" error={errors.description}>
              <Textarea
                id="project-description"
                name="description"
                data-testid="project-description-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this project delivers, and any shared context…"
                disabled={submitting}
              />
            </Field>
            <Field
              label="Repository URL"
              htmlFor="project-repo-url"
              error={errors.repoUrl}
              hint="Optional. Used for display and future clone operations; bindings hold the local path."
            >
              <Input
                id="project-repo-url"
                name="repoUrl"
                data-testid="project-repo-url-input"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="git@github.com:org/repo.git"
                autoComplete="off"
                aria-invalid={Boolean(errors.repoUrl)}
                disabled={submitting}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
              <Field
                label="Default branch"
                htmlFor="project-default-branch"
                required
                error={errors.defaultBranch}
              >
                <Input
                  id="project-default-branch"
                  name="defaultBranch"
                  data-testid="project-default-branch-input"
                  value={defaultBranch}
                  onChange={(event) => setDefaultBranch(event.target.value)}
                  placeholder="main"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.defaultBranch)}
                  disabled={submitting}
                />
              </Field>
              <Field label="Color" htmlFor="project-color" error={errors.color}>
                <Input
                  id="project-color"
                  name="color"
                  type="color"
                  data-testid="project-color-input"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                  className="h-9 p-1"
                  aria-invalid={Boolean(errors.color)}
                  disabled={submitting}
                />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="project-cancel-button"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              data-testid="project-submit-button"
            >
              {submitting ? 'Saving…' : mode === 'create' ? 'Create project' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
