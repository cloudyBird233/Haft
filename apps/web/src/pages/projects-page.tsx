import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@raft-lite/contracts';
import { Plus, Search } from 'lucide-react';
import { useComputers, useProjects } from '../hooks/use-raft-data';
import { api } from '../services/api';
import { queryKeys } from '../services/query-keys';
import { useToast } from '../providers/toast-provider';
import { Button } from '../components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/feedback';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { ProjectCard } from '../features/projects/project-card';
import { ProjectDetailDrawer } from '../features/projects/project-detail-drawer';
import {
  ProjectFormDialog,
  type ProjectFormSubmission,
} from '../features/projects/project-form-dialog';

export function ProjectsPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProjectId = searchParams.get('project');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectDto | null>(null);

  const projectsQuery = useProjects();
  const computersQuery = useComputers();
  const projects = projectsQuery.data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) =>
      [project.name, project.key, project.description, project.repoUrl ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [projects, search]);

  function setSelectedProject(projectId: string | null): void {
    const next = new URLSearchParams(searchParams);
    if (projectId) {
      next.set('project', projectId);
    } else {
      next.delete('project');
    }
    setSearchParams(next, { replace: true });
  }

  function invalidateProjects(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
  }

  function openCreate(): void {
    setEditingProject(null);
    setFormOpen(true);
  }

  function openEdit(project: ProjectDto): void {
    setEditingProject(project);
    setFormOpen(true);
  }

  async function handleFormSubmit(values: ProjectFormSubmission): Promise<void> {
    if (editingProject) {
      await api.updateProject(editingProject.id, {
        name: values.name,
        description: values.description,
        color: values.color,
        repoUrl: values.repoUrl,
        defaultBranch: values.defaultBranch,
      });
      invalidateProjects();
      toast({
        title: 'Project updated',
        description: `${values.name} now uses ${values.defaultBranch} as its default branch.`,
        variant: 'success',
      });
    } else {
      const created = await api.createProject({
        key: values.key,
        name: values.name,
        description: values.description,
        color: values.color,
        repoUrl: values.repoUrl,
        defaultBranch: values.defaultBranch,
      });
      invalidateProjects();
      setSearch('');
      setSelectedProject(created.id);
      toast({
        title: 'Project created',
        description: `${created.name} is ready. Bind a repository to make it executable.`,
        variant: 'success',
      });
    }
  }

  return (
    <div data-testid="projects-page">
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        description="Group tasks under a project, then bind each repository path on the computer that will execute it."
        testId="projects-header"
        actions={
          <Button variant="primary" onClick={openCreate} data-testid="project-create-button">
            <Plus size={14} aria-hidden="true" />
            New project
          </Button>
        }
      />

      <div className="panel mb-4 flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-[360px]">
          <label htmlFor="project-search" className="sr-only">
            Search projects
          </label>
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            id="project-search"
            type="search"
            data-testid="project-search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search projects by name, key, or repository"
            className="pl-8"
            autoComplete="off"
          />
        </div>
        <div
          className="ml-auto hidden text-[10.5px] text-faint sm:block"
          data-testid="projects-count"
        >
          {projectsQuery.data ? `${projectsQuery.data.total} projects` : ''}
        </div>
      </div>

      {projectsQuery.isLoading ? (
        <div
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label="Loading projects"
          data-testid="projects-loading"
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-[218px] rounded-2xl" />
          ))}
        </div>
      ) : projectsQuery.isError ? (
        <ErrorState
          title="Projects could not be loaded"
          description={
            projectsQuery.error instanceof Error
              ? projectsQuery.error.message
              : 'The project list request failed.'
          }
          onRetry={() => void projectsQuery.refetch()}
          testId="projects-error"
          retryTestId="projects-retry-button"
        />
      ) : projects.length === 0 ? (
        <EmptyState
          title="Create your first project"
          description="Projects carry the default branch and the repository bindings that real executions depend on."
          testId="projects-empty"
          action={
            <Button
              variant="primary"
              onClick={openCreate}
              data-testid="projects-empty-create-button"
            >
              <Plus size={14} aria-hidden="true" />
              Create project
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No projects match that search"
          description="Try a shorter name or clear the search field."
          testId="projects-filter-empty"
          action={
            <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          data-testid="project-list"
          role="list"
          aria-label="Project list"
        >
          {filtered.map((project) => (
            <div key={project.id} role="listitem">
              <ProjectCard project={project} onOpen={setSelectedProject} />
            </div>
          ))}
        </div>
      )}

      <ProjectDetailDrawer
        projectId={selectedProjectId}
        open={Boolean(selectedProjectId)}
        onOpenChange={(open) => {
          if (!open) setSelectedProject(null);
        }}
        computers={computersQuery.data?.items ?? []}
        onEdit={openEdit}
        onDeleted={() => setSelectedProject(null)}
      />

      <ProjectFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingProject(null);
        }}
        mode={editingProject ? 'edit' : 'create'}
        initial={editingProject}
        onSubmit={handleFormSubmit}
      />
    </div>
  );
}
