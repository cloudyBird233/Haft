import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import type { ListDto, TaskDto } from '@raft-lite/contracts';
import { TasksPage } from '../pages/tasks-page';
import { ToastProvider } from '../providers/toast-provider';
import { api } from '../services/api';
import { testAgents, testProject, testTasks } from './fixtures';

vi.mock('../services/api', () => {
  class ApiError extends Error {
    code = 'MOCK_ERROR';
  }
  return {
    ApiError,
    api: {
      listTasks: vi.fn(),
      listAgents: vi.fn(),
      getWorkspace: vi.fn(),
      getTask: vi.fn(),
    },
  };
});

const listTasksMock = vi.mocked(api.listTasks as MockedFunction<typeof api.listTasks>);

function renderTasksPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <MemoryRouter initialEntries={['/tasks']}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TasksPage />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function filteredTasks(filters: { search?: string; status?: string }): ListDto<TaskDto> {
  const items = testTasks.filter((task) => {
    const matchesSearch =
      !filters.search ||
      task.title.toLowerCase().includes(filters.search.toLowerCase()) ||
      task.description.toLowerCase().includes(filters.search.toLowerCase());
    const matchesStatus = !filters.status || task.status === filters.status;
    return matchesSearch && matchesStatus;
  });
  return { items, total: items.length };
}

describe('TasksPage interaction states', () => {
  beforeEach(() => {
    listTasksMock.mockReset();
    listTasksMock.mockImplementation(async (filters) => filteredTasks(filters ?? {}));
    vi.mocked(api.listAgents).mockResolvedValue({ items: testAgents, total: testAgents.length });
    vi.mocked(api.getWorkspace).mockResolvedValue({
      id: 'ws_demo',
      name: 'Raft Lite',
      slug: 'raft-lite',
      createdAt: '2026-01-12T14:00:00.000Z',
      projects: [testProject],
    });
  });

  it('searches tasks and applies a status filter through accessible controls', async () => {
    const user = userEvent.setup();
    renderTasksPage();
    expect(await screen.findByText('Audit log viewer')).toBeVisible();
    expect(screen.getByText('Ship settings panel')).toBeVisible();

    await user.type(screen.getByLabelText('Search tasks'), 'audit');
    await waitFor(() =>
      expect(listTasksMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'audit' })),
    );
    await waitFor(() => expect(screen.queryByText('Ship settings panel')).not.toBeInTheDocument());
    expect(screen.getByText('Audit log viewer')).toBeVisible();

    await user.clear(screen.getByLabelText('Search tasks'));
    await user.selectOptions(screen.getByLabelText('Status filter'), 'in_progress');
    await waitFor(() =>
      expect(listTasksMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'in_progress' }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('Ship settings panel')).not.toBeInTheDocument());
  });

  it('renders the loading state while the board request is pending', async () => {
    let resolveRequest: ((value: ListDto<TaskDto>) => void) | undefined;
    listTasksMock.mockImplementation(
      () =>
        new Promise<ListDto<TaskDto>>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    renderTasksPage();
    expect(await screen.findByTestId('tasks-loading')).toBeVisible();
    resolveRequest?.({ items: [], total: 0 });
    expect(await screen.findByTestId('tasks-empty')).toBeVisible();
  });

  it('renders an empty state when the workspace has no tasks', async () => {
    listTasksMock.mockResolvedValue({ items: [], total: 0 });
    renderTasksPage();
    expect(await screen.findByTestId('tasks-empty')).toBeVisible();
    expect(screen.getByTestId('tasks-empty-create-button')).toBeVisible();
  });

  it('renders a retryable error state when the API fails', async () => {
    listTasksMock.mockRejectedValue(new Error('Simulated API outage'));
    renderTasksPage();
    expect(await screen.findByTestId('tasks-error')).toBeVisible();
    expect(screen.getByTestId('tasks-error')).toHaveTextContent('Simulated API outage');
    expect(screen.getByTestId('tasks-retry-button')).toBeVisible();
  });
});
