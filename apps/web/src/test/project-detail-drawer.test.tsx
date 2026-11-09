import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectBindingDto, ProjectDetailDto } from '@raft-lite/contracts';
import { ProjectDetailDrawer } from '../features/projects/project-detail-drawer';
import { ToastProvider } from '../providers/toast-provider';
import { api } from '../services/api';
import { testBinding, testComputer, testProject } from './fixtures';

vi.mock('../services/api', () => {
  class ApiError extends Error {
    code = 'MOCK_ERROR';
    status = 400;
    details: unknown = null;
  }
  return {
    ApiError,
    api: {
      getProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
      createProjectBinding: vi.fn(),
      updateProjectBinding: vi.fn(),
      deleteProjectBinding: vi.fn(),
      validateProjectBinding: vi.fn(),
    },
  };
});

const getProjectMock = vi.mocked(api.getProject);

function detail(bindings: ProjectBindingDto[] = []): ProjectDetailDto {
  return {
    ...testProject,
    bindings,
    bindingCount: bindings.length,
  };
}

function renderDrawer(
  options: { bindings?: ProjectBindingDto[]; computers?: (typeof testComputer)[] } = {},
) {
  getProjectMock.mockResolvedValue(detail(options.bindings ?? []));
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ProjectDetailDrawer
            projectId={testProject.id}
            open
            onOpenChange={vi.fn()}
            computers={options.computers ?? [testComputer]}
            onEdit={vi.fn()}
            onDeleted={vi.fn()}
          />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ProjectDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows binding state, validation errors, and the last validation time', async () => {
    renderDrawer({
      bindings: [
        {
          ...testBinding,
          status: 'error',
          headCommit: null,
          validationErrorCode: 'REPO_NOT_GIT_ROOT',
          validationError: 'The path is not the root of a Git worktree',
        },
      ],
    });

    expect(await screen.findByTestId('project-binding-row')).toHaveAttribute(
      'data-binding-status',
      'error',
    );
    expect(screen.getByText('C:\\work\\raft-lite')).toBeVisible();
    const error = screen.getByTestId('binding-validation-error');
    expect(error).toHaveTextContent('REPO_NOT_GIT_ROOT');
    expect(error).toHaveTextContent('The path is not the root of a Git worktree');
    expect(screen.getByText(/Last checked/)).toBeVisible();
    expect(screen.getByText('Validation failed. Real executions are blocked.')).toBeVisible();
  });

  it('creates a binding for an available computer through the real API client', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createProjectBinding).mockResolvedValue(testBinding);
    renderDrawer();
    await screen.findByTestId('project-bindings-empty');

    await user.click(screen.getByTestId('project-binding-create-button'));
    expect(await screen.findByTestId('binding-form-dialog')).toBeVisible();
    await user.click(screen.getByTestId('binding-submit-button'));
    expect(await screen.findByText('Repository path is required')).toBeVisible();
    expect(api.createProjectBinding).not.toHaveBeenCalled();

    await user.type(screen.getByTestId('binding-path-input'), 'C:\\work\\raft-lite');
    await user.click(screen.getByTestId('binding-submit-button'));

    await waitFor(() => expect(api.createProjectBinding).toHaveBeenCalledTimes(1));
    expect(api.createProjectBinding).toHaveBeenCalledWith(testProject.id, {
      computerId: testComputer.id,
      path: 'C:\\work\\raft-lite',
    });
  });

  it('changes a binding path and forces a new validation', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateProjectBinding).mockResolvedValue({
      ...testBinding,
      path: '/srv/repos/haft',
      status: 'unverified',
      bindingVersion: 2,
    });
    renderDrawer({ bindings: [testBinding] });
    await screen.findByTestId('project-binding-row');

    await user.click(screen.getByTestId('binding-edit-button'));
    expect(await screen.findByTestId('binding-form-dialog')).toBeVisible();
    expect(screen.getByTestId('binding-path-input')).toHaveValue('C:\\work\\raft-lite');
    expect(screen.getByTestId('binding-computer-select')).toBeDisabled();
    await user.clear(screen.getByTestId('binding-path-input'));
    await user.type(screen.getByTestId('binding-path-input'), '/srv/repos/haft');
    await user.click(screen.getByTestId('binding-submit-button'));

    await waitFor(() => expect(api.updateProjectBinding).toHaveBeenCalledTimes(1));
    expect(api.updateProjectBinding).toHaveBeenCalledWith(testProject.id, testBinding.id, {
      path: '/srv/repos/haft',
    });
  });

  it('validates a binding through the runner endpoint', async () => {
    const user = userEvent.setup();
    vi.mocked(api.validateProjectBinding).mockResolvedValue({
      ...testBinding,
      status: 'ready',
      validationErrorCode: null,
      validationError: null,
    });
    renderDrawer({ bindings: [{ ...testBinding, status: 'unverified', headCommit: null }] });
    await screen.findByTestId('project-binding-row');

    await user.click(screen.getByTestId('binding-validate-button'));
    await waitFor(() =>
      expect(api.validateProjectBinding).toHaveBeenCalledWith(testProject.id, testBinding.id),
    );
    expect(await screen.findByText('Repository validated')).toBeVisible();
  });

  it('deletes a binding only after confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteProjectBinding).mockResolvedValue({ id: testBinding.id });
    renderDrawer({ bindings: [testBinding] });
    await screen.findByTestId('project-binding-row');

    await user.click(screen.getByTestId('binding-delete-button'));
    const dialog = await screen.findByTestId('binding-delete-dialog');
    expect(within(dialog).getByText('Delete this repository binding?')).toBeVisible();
    await user.click(screen.getByTestId('binding-delete-confirm-button'));

    await waitFor(() =>
      expect(api.deleteProjectBinding).toHaveBeenCalledWith(testProject.id, testBinding.id),
    );
  });

  it('archives the project through the immutable project API', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateProject).mockResolvedValue(detail());
    renderDrawer();
    await screen.findByText('Raft Lite');

    await user.click(screen.getByTestId('project-archive-button'));
    await user.click(await screen.findByTestId('project-archive-confirm-button'));

    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith(testProject.id, { archived: true }),
    );
  });
});
