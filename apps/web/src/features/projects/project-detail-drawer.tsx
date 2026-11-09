import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ComputerDto, ProjectBindingDto, ProjectDto } from '@raft-lite/contracts';
import {
  Archive,
  ArchiveRestore,
  GitBranch,
  GitFork,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '../../services/api';
import { queryKeys } from '../../services/query-keys';
import { useProject } from '../../hooks/use-raft-data';
import { useToast } from '../../providers/toast-provider';
import { formatShortDateTime } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog';
import { EmptyState, ErrorState } from '../../components/ui/feedback';
import { ProjectBindingStatusBadge } from '../../components/ui/status-badge';
import {
  ProjectBindingFormDialog,
  type BindingFormSubmission,
} from './project-binding-form-dialog';

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The action could not be completed.';
}

export function ProjectDetailDrawer({
  projectId,
  open,
  onOpenChange,
  computers,
  onEdit,
  onDeleted,
}: {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computers: ComputerDto[];
  onEdit: (project: ProjectDto) => void;
  onDeleted: () => void;
}): JSX.Element {
  const query = useProject(projectId, open);
  const project = query.data;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [bindingFormOpen, setBindingFormOpen] = useState(false);
  const [editingBinding, setEditingBinding] = useState<ProjectBindingDto | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [deleteBindingTarget, setDeleteBindingTarget] = useState<ProjectBindingDto | null>(null);
  const [deletingBinding, setDeletingBinding] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    if (projectId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    }
  }

  function openCreateBinding(): void {
    setEditingBinding(null);
    setBindingFormOpen(true);
  }

  function openEditBinding(binding: ProjectBindingDto): void {
    setEditingBinding(binding);
    setBindingFormOpen(true);
  }

  async function handleBindingSubmit(values: BindingFormSubmission): Promise<void> {
    if (!project) return;
    if (editingBinding) {
      await api.updateProjectBinding(project.id, editingBinding.id, { path: values.path });
      toast({
        title: 'Repository path updated',
        description: 'Validate the binding again before starting a real execution.',
        variant: 'success',
      });
    } else {
      await api.createProjectBinding(project.id, {
        computerId: values.computerId,
        path: values.path,
      });
      toast({
        title: 'Repository binding created',
        description: 'Validate the path with the runner to make it executable.',
        variant: 'success',
      });
    }
    invalidate();
  }

  async function handleValidate(binding: ProjectBindingDto): Promise<void> {
    if (!project) return;
    setValidatingId(binding.id);
    try {
      const result = await api.validateProjectBinding(project.id, binding.id);
      toast({
        title: 'Repository validated',
        description: `${binding.computer?.name ?? 'The runner'} confirmed ${result.canonicalPath ?? binding.path}.`,
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: 'Repository validation failed',
        description: errorMessage(error),
        variant: 'error',
      });
    } finally {
      setValidatingId(null);
      invalidate();
    }
  }

  async function handleDeleteBinding(): Promise<void> {
    if (!project || !deleteBindingTarget) return;
    setDeletingBinding(true);
    try {
      await api.deleteProjectBinding(project.id, deleteBindingTarget.id);
      setDeleteBindingTarget(null);
      invalidate();
      toast({ title: 'Repository binding deleted', variant: 'success' });
    } catch (error) {
      toast({
        title: 'Binding could not be deleted',
        description: errorMessage(error),
        variant: 'error',
      });
    } finally {
      setDeletingBinding(false);
    }
  }

  async function handleArchiveToggle(): Promise<void> {
    if (!project) return;
    setArchiving(true);
    try {
      const archived = !project.archivedAt;
      await api.updateProject(project.id, { archived });
      setArchiveOpen(false);
      invalidate();
      toast({
        title: archived ? 'Project archived' : 'Project restored',
        description: archived
          ? 'New tasks can no longer select this project.'
          : 'The project is selectable for new tasks again.',
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: project.archivedAt
          ? 'Project could not be restored'
          : 'Project could not be archived',
        description: errorMessage(error),
        variant: 'error',
      });
    } finally {
      setArchiving(false);
    }
  }

  async function handleDeleteProject(): Promise<void> {
    if (!project) return;
    setDeleting(true);
    try {
      await api.deleteProject(project.id);
      setDeleteOpen(false);
      onOpenChange(false);
      onDeleted();
      invalidate();
      toast({ title: 'Project deleted', variant: 'success' });
    } catch (error) {
      toast({
        title: 'Project could not be deleted',
        description: errorMessage(error),
        variant: 'error',
      });
    } finally {
      setDeleting(false);
    }
  }

  const bindings = project?.bindings ?? [];
  const boundComputerIds = new Set(bindings.map((binding) => binding.computerId));
  const availableComputers = computers.filter((computer) => !boundComputerIds.has(computer.id));
  const formComputers = editingBinding ? computers : availableComputers;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setBindingFormOpen(false);
            setEditingBinding(null);
          }
          onOpenChange(next);
        }}
      >
        <DialogContent
          side="drawer"
          testId="project-detail-panel"
          ariaLabel={project ? `Project details for ${project.name}` : 'Project details'}
          className="sm:w-[560px]"
        >
          <div className="flex-1 overflow-y-auto">
            <div className="border-b border-line bg-[#fbfaf7] px-5 pb-4 pt-5 pr-14">
              {project ? (
                <>
                  <p className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.15em] text-faint">
                    {project.key} · Project
                  </p>
                  <DialogTitle className="text-[18px] font-semibold leading-6 tracking-[-0.025em] text-ink">
                    {project.name}
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-[11.5px] text-muted">
                    Created {formatShortDateTime(project.createdAt)}
                  </DialogDescription>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {project.archivedAt ? (
                      <span
                        className="rounded-full border border-line bg-[#f3f1ec] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#706c64]"
                        data-testid="project-detail-archived"
                      >
                        Archived
                      </span>
                    ) : (
                      <span className="rounded-full border border-[#cfe0d6] bg-[#e9f3ed] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#336248]">
                        Active
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <DialogTitle className="text-[18px] font-semibold text-ink">
                    Project details
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                    Loading project details.
                  </DialogDescription>
                </>
              )}
            </div>

            {query.isLoading ? (
              <div className="flex min-h-[340px] items-center justify-center" role="status">
                <span className="text-[12px] text-muted">Loading project…</span>
              </div>
            ) : query.isError && query.error instanceof ApiError && query.error.status === 404 ? (
              <div className="p-5">
                <EmptyState
                  title="Project not found"
                  description="This project may have been deleted."
                  testId="project-detail-not-found"
                />
              </div>
            ) : query.isError ? (
              <div className="p-5">
                <ErrorState
                  title="Project could not be loaded"
                  description={
                    query.error instanceof Error ? query.error.message : 'Please try again.'
                  }
                  onRetry={() => void query.refetch()}
                  testId="project-detail-error"
                  retryTestId="project-detail-retry-button"
                />
              </div>
            ) : project ? (
              <div className="space-y-6 px-5 py-5">
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                    Overview
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-5 text-muted">
                    {project.description || 'No description provided.'}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line bg-[#fbfaf7] p-3.5 text-[11.5px]">
                    <div className="col-span-2 min-w-0">
                      <dt className="flex items-center gap-1.5 text-faint">
                        <GitFork size={11} aria-hidden="true" /> Repository URL
                      </dt>
                      <dd className="mt-0.5 truncate font-mono font-medium text-ink">
                        {project.repoUrl ?? 'Not set'}
                      </dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1.5 text-faint">
                        <GitBranch size={11} aria-hidden="true" /> Default branch
                      </dt>
                      <dd className="mt-0.5 font-mono font-medium text-ink">
                        {project.defaultBranch}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-faint">Workload</dt>
                      <dd className="mt-0.5 font-medium text-ink">
                        {project.taskCount ?? 0} tasks · {project.executionCount ?? 0} runs
                      </dd>
                    </div>
                  </dl>
                </section>

                <section>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
                        Repository bindings
                      </h3>
                      <p className="mt-1 text-[11px] text-muted">
                        A real execution needs a validated binding on the assigned computer.
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={openCreateBinding}
                      disabled={availableComputers.length === 0}
                      title={
                        availableComputers.length === 0
                          ? computers.length === 0
                            ? 'No computers are registered'
                            : 'Every computer already has a binding'
                          : 'Bind this repository on a computer'
                      }
                      data-testid="project-binding-create-button"
                    >
                      <Plus size={12} aria-hidden="true" />
                      Bind
                    </Button>
                  </div>

                  {bindings.length === 0 ? (
                    <EmptyState
                      title="No repository binding"
                      description="Bind the project to a path on a computer before starting a real execution."
                      className="mt-2 min-h-[130px] py-6"
                      testId="project-bindings-empty"
                    />
                  ) : (
                    <div className="mt-2 space-y-2.5" data-testid="project-bindings">
                      {bindings.map((binding) => (
                        <div
                          key={binding.id}
                          className="rounded-xl border border-line bg-panel p-3.5"
                          data-testid="project-binding-row"
                          data-binding-id={binding.id}
                          data-binding-status={binding.status}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-[12px] font-semibold text-ink">
                                {binding.computer?.name ?? binding.computerId}
                              </p>
                              <p
                                className="mt-0.5 truncate font-mono text-[10.5px] text-muted"
                                title={binding.path}
                              >
                                {binding.path}
                              </p>
                            </div>
                            <ProjectBindingStatusBadge status={binding.status} />
                          </div>

                          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-faint">
                            <span>
                              {binding.lastValidatedAt
                                ? `Last checked ${formatShortDateTime(binding.lastValidatedAt)}`
                                : 'Never validated'}
                            </span>
                            {binding.headCommit ? (
                              <span className="font-mono">
                                HEAD {binding.headCommit.slice(0, 8)}
                              </span>
                            ) : null}
                          </div>

                          {binding.validationError ? (
                            <p
                              role="alert"
                              data-testid="binding-validation-error"
                              className="mt-2 rounded-lg border border-danger/20 bg-[#fbf1ee] px-2.5 py-2 text-[11px] leading-4 text-[#873d2f]"
                            >
                              {binding.validationErrorCode ? (
                                <span className="font-mono">{binding.validationErrorCode}: </span>
                              ) : null}
                              {binding.validationError}
                            </p>
                          ) : null}

                          <p className="mt-2 text-[10.5px] leading-4 text-muted">
                            {binding.status === 'ready'
                              ? 'Ready for real executions on this computer.'
                              : binding.status === 'missing'
                                ? 'The path is missing. Real executions are blocked.'
                                : binding.status === 'error'
                                  ? 'Validation failed. Real executions are blocked.'
                                  : 'Not executable until the runner validates this path.'}
                          </p>

                          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void handleValidate(binding)}
                              loading={validatingId === binding.id}
                              disabled={validatingId !== null}
                              data-testid="binding-validate-button"
                            >
                              <ShieldCheck size={12} aria-hidden="true" />
                              {validatingId === binding.id
                                ? 'Validating…'
                                : binding.status === 'ready'
                                  ? 'Revalidate'
                                  : 'Validate'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditBinding(binding)}
                              disabled={validatingId !== null}
                              data-testid="binding-edit-button"
                            >
                              <Pencil size={11} aria-hidden="true" />
                              Change path
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteBindingTarget(binding)}
                              disabled={validatingId !== null}
                              data-testid="binding-delete-button"
                              className="text-danger hover:bg-danger/[0.06] hover:text-danger"
                            >
                              <Trash2 size={11} aria-hidden="true" />
                              Delete
                            </Button>
                            {validatingId === binding.id ? (
                              <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-faint">
                                <RefreshCw size={10} className="animate-spin" aria-hidden="true" />
                                Waiting for the runner
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="p-5">
                <EmptyState
                  title="Project not found"
                  description="This project may have been deleted."
                  testId="project-detail-not-found"
                />
              </div>
            )}
          </div>

          {project ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line bg-[#fcfbf8] px-5 py-3.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setArchiveOpen(true)}
                data-testid="project-archive-button"
              >
                {project.archivedAt ? (
                  <ArchiveRestore size={13} aria-hidden="true" />
                ) : (
                  <Archive size={13} aria-hidden="true" />
                )}
                {project.archivedAt ? 'Restore' : 'Archive'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                className="text-danger hover:bg-danger/[0.06] hover:text-danger"
                data-testid="project-delete-button"
              >
                <Trash2 size={13} aria-hidden="true" />
                Delete
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto"
                onClick={() => onEdit(project)}
                data-testid="project-edit-button"
              >
                <Pencil size={12} aria-hidden="true" />
                Edit project
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {project ? (
        <ProjectBindingFormDialog
          open={bindingFormOpen}
          onOpenChange={(next) => {
            setBindingFormOpen(next);
            if (!next) setEditingBinding(null);
          }}
          mode={editingBinding ? 'edit' : 'create'}
          projectName={project.name}
          binding={editingBinding}
          computers={formComputers}
          onSubmit={handleBindingSubmit}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteBindingTarget)}
        onOpenChange={(next) => {
          if (!next) setDeleteBindingTarget(null);
        }}
        title="Delete this repository binding?"
        description={
          <>
            The binding for{' '}
            <strong>{deleteBindingTarget?.computer?.name ?? 'this computer'}</strong> will be
            removed. Real executions that need it will be blocked. Historical execution snapshots
            are preserved.
          </>
        }
        confirmLabel="Delete binding"
        onConfirm={() => void handleDeleteBinding()}
        pending={deletingBinding}
        danger
        testId="binding-delete-dialog"
        confirmTestId="binding-delete-confirm-button"
        cancelTestId="binding-delete-cancel-button"
      />

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={project?.archivedAt ? 'Restore this project?' : 'Archive this project?'}
        description={
          project?.archivedAt
            ? 'The project becomes selectable for new tasks again. Existing tasks and bindings are unchanged.'
            : 'New tasks can no longer select this project. Existing tasks, executions, and bindings are preserved.'
        }
        confirmLabel={project?.archivedAt ? 'Restore project' : 'Archive project'}
        onConfirm={() => void handleArchiveToggle()}
        pending={archiving}
        testId="project-archive-dialog"
        confirmTestId="project-archive-confirm-button"
        cancelTestId="project-archive-cancel-button"
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this project?"
        description={
          (project?.taskCount ?? 0) > 0
            ? `This project still has ${project?.taskCount} task(s). Delete or move them first, or archive the project instead.`
            : 'The project and its repository bindings will be removed. This action cannot be undone.'
        }
        confirmLabel="Delete project"
        onConfirm={() => void handleDeleteProject()}
        pending={deleting}
        danger
        testId="project-delete-dialog"
        confirmTestId="project-delete-confirm-button"
        cancelTestId="project-delete-cancel-button"
      />
    </>
  );
}
