import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateProjectInput, ListDto, ProjectDto } from '@raft-lite/contracts';
import { ProjectsPage } from '../pages/projects-page';
import { ToastProvider } from '../providers/toast-provider';
import { api } from '../services/api';
import { testArchivedProject, testComputer, testProject } from './fixtures';

vi.mock('../services/api', () => {
  class ApiError extends Error {
    code = 'MOCK_ERROR';
    status = 400;
    details: unknown = null;
  }
  return {
    ApiError,
    api: {
      listProjects: vi.fn(),
      getProject: vi.fn(),
      getComputers: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
      createProjectBinding: vi.fn(),
      updateProjectBinding: vi.fn(),
      deleteProjectBinding: vi.fn(),
    },
  };
});

const listProjectsMock = vi.mocked(api.listProjects);
const createProjectMock = vi.mocked(api.createProject);

function renderProjectsPage(initialEntry = '/projects') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ProjectsPage />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function projectList(items: ProjectDto[]): ListDto<ProjectDto> {
  return { items, total: items.length };
}

describe('ProjectsPage', () => {
  beforeEach(() => {
    listProjectsMock.mockReset();
    createProjectMock.mockReset();
    vi.mocked(api.getComputers).mockResolvedValue({
      items: [testComputer],
      total: 1,
    });
    vi.mocked(api.getProject).mockResolvedValue({
      ...testProject,
      bindings: [],
    });
  });

  it('renders project branch metadata, counts, and archived state', async () => {
    listProjectsMock.mockResolvedValue(projectList([testProject, testArchivedProject]));
    renderProjectsPage();

    const cards = await screen.findAllByTestId('project-card');
    expect(cards).toHaveLength(2);
    const active = cards.find((card) => card.getAttribute('data-project-id') === 'project_demo');
    expect(active).toBeDefined();
    expect(within(active as HTMLElement).getByText('Raft Lite')).toBeVisible();
    expect(within(active as HTMLElement).getByText('main')).toBeVisible();
    expect(within(active as HTMLElement).getByTestId('project-task-count')).toHaveTextContent('4');
    expect(within(active as HTMLElement).getByTestId('project-execution-count')).toHaveTextContent(
      '2',
    );
    expect(
      within(active as HTMLElement).queryByTestId('project-archived-badge'),
    ).not.toBeInTheDocument();

    const archived = cards.find(
      (card) => card.getAttribute('data-project-id') === 'project_archived',
    );
    expect(within(archived as HTMLElement).getByTestId('project-archived-badge')).toBeVisible();
  });

  it('searches projects by name and handles a filter miss', async () => {
    const user = userEvent.setup();
    listProjectsMock.mockResolvedValue(projectList([testProject, testArchivedProject]));
    renderProjectsPage();
    await screen.findAllByTestId('project-card');

    await user.type(screen.getByLabelText('Search projects'), 'Raft');
    await waitFor(() => expect(screen.getAllByTestId('project-card')).toHaveLength(1));
    expect(screen.getByText('Raft Lite')).toBeVisible();

    await user.clear(screen.getByLabelText('Search projects'));
    await user.type(screen.getByLabelText('Search projects'), 'does-not-exist');
    expect(await screen.findByTestId('projects-filter-empty')).toBeVisible();
  });

  it('renders loading, empty, and retryable error states', async () => {
    let resolveRequest: ((value: ListDto<ProjectDto>) => void) | undefined;
    listProjectsMock.mockImplementation(
      () =>
        new Promise<ListDto<ProjectDto>>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const view = renderProjectsPage();
    expect(await screen.findByTestId('projects-loading')).toBeVisible();
    resolveRequest?.(projectList([]));
    expect(await screen.findByTestId('projects-empty')).toBeVisible();
    view.unmount();

    listProjectsMock.mockRejectedValue(new Error('Simulated project outage'));
    renderProjectsPage();
    expect(await screen.findByTestId('projects-error')).toBeVisible();
    expect(screen.getByTestId('projects-error')).toHaveTextContent('Simulated project outage');
    expect(screen.getByTestId('projects-retry-button')).toBeVisible();
  });

  it('creates a project with the default branch through the real API client', async () => {
    const user = userEvent.setup();
    listProjectsMock.mockResolvedValue(projectList([]));
    createProjectMock.mockImplementation(async (input: CreateProjectInput) => ({
      ...testProject,
      ...input,
      id: 'project_created',
      key: input.key,
    }));
    renderProjectsPage();
    await screen.findByTestId('projects-empty');

    await user.click(screen.getByTestId('projects-empty-create-button'));
    await user.click(screen.getByTestId('project-submit-button'));
    expect(await screen.findByText('Project key must be at least 2 characters')).toBeVisible();
    expect(createProjectMock).not.toHaveBeenCalled();

    await user.type(screen.getByTestId('project-key-input'), 'haft');
    await user.type(screen.getByTestId('project-name-input'), 'Haft Platform');
    await user.clear(screen.getByTestId('project-default-branch-input'));
    await user.type(screen.getByTestId('project-default-branch-input'), 'develop');
    await user.click(screen.getByTestId('project-submit-button'));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalledTimes(1));
    expect(createProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'HAFT',
        name: 'Haft Platform',
        defaultBranch: 'develop',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('project-form-dialog')).not.toBeInTheDocument(),
    );
  });
});
