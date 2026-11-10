import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSummaryDto,
  ProjectBindingDto,
  ProjectDetailDto,
  TaskDetailDto,
} from '@raft-lite/contracts';
import { TaskDetailDrawer } from '../features/tasks/task-detail-drawer';
import { ToastProvider } from '../providers/toast-provider';
import { api } from '../services/api';
import { testBinding, testComputer, testProject, testTasks } from './fixtures';

vi.mock('../services/api', () => {
  class ApiError extends Error {
    code = 'MOCK_ERROR';
    status = 400;
    details: unknown = null;
  }
  return {
    ApiError,
    api: {
      getTask: vi.fn(),
      getProject: vi.fn(),
      listRuntimes: vi.fn(),
      startTask: vi.fn(),
      updateTask: vi.fn(),
      assignTask: vi.fn(),
      deleteTask: vi.fn(),
      cancelTask: vi.fn(),
    },
  };
});

const codexAgent: AgentSummaryDto = {
  id: 'agent_codex',
  name: 'Codex Runner',
  role: 'Implementation Agent',
  status: 'idle',
  runtime: 'codex',
  computerId: testComputer.id,
};

function taskDetail(): TaskDetailDto {
  return {
    ...(testTasks[0] as TaskDetailDto),
    assignee: codexAgent,
    project: testProject,
    executions: [],
    executionCount: 0,
  };
}

function projectDetail(bindings: ProjectBindingDto[]): ProjectDetailDto {
  return { ...testProject, bindings, bindingCount: bindings.length };
}

function renderDrawer(bindings: ProjectBindingDto[]) {
  vi.mocked(api.getTask).mockResolvedValue(taskDetail());
  vi.mocked(api.getProject).mockResolvedValue(projectDetail(bindings));
  vi.mocked(api.listRuntimes).mockResolvedValue({
    items: [
      {
        runtime: 'codex',
        label: 'Codex',
        available: true,
        requiresRunner: true,
        reason: null,
        reasonCode: null,
        runnerId: 'runner_test',
        runnerStatus: 'online',
        cliVersion: '0.164.0',
        authenticated: true,
        projectIds: [testProject.id],
      },
    ],
  });
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
          <TaskDetailDrawer
            taskId="task_audit"
            open
            onOpenChange={vi.fn()}
            agents={[]}
            onEdit={vi.fn()}
            onDeleted={vi.fn()}
          />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('TaskDetailDrawer repository binding guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks a real execution until the binding is validated', async () => {
    renderDrawer([
      {
        ...testBinding,
        status: 'unverified',
        canonicalPath: null,
        lastValidatedAt: null,
        validatedByRunnerId: null,
        validatedBindingVersion: null,
      },
    ]);

    expect(await screen.findByTestId('task-project-binding-link')).toHaveAttribute(
      'href',
      `/projects?project=${testProject.id}`,
    );
    expect(screen.getByTestId('execution-start-hint')).toHaveTextContent(
      'Repository binding: Unverified. P2-02 repository validation is required before starting a real execution',
    );
    expect(screen.getByTestId('execution-start-button')).toBeDisabled();
    expect(api.startTask).not.toHaveBeenCalled();
  });

  it('blocks a real execution when the assigned computer has no binding', async () => {
    renderDrawer([]);
    expect(await screen.findByTestId('execution-start-hint')).toHaveTextContent(
      'This project has no repository binding on the assigned computer',
    );
    expect(screen.getByTestId('execution-start-button')).toBeDisabled();
  });

  it('blocks a binding whose path changed after the last validation', async () => {
    renderDrawer([{ ...testBinding, bindingVersion: 2, validatedBindingVersion: 1 }]);
    expect(await screen.findByTestId('execution-start-hint')).toHaveTextContent(
      'The repository binding changed after validation and must be revalidated by P2-02',
    );
    expect(screen.getByTestId('execution-start-button')).toBeDisabled();
  });

  it('allows a real execution when the binding is ready and current', async () => {
    const user = userEvent.setup();
    vi.mocked(api.startTask).mockResolvedValue({
      id: 'execution_ready',
      taskId: 'task_audit',
      agentId: codexAgent.id,
      runtime: 'codex',
      runnerId: 'runner_test',
      status: 'running',
      phase: 'preparing',
      progress: 0,
      progressMode: 'determinate',
      startedAt: new Date().toISOString(),
      endedAt: null,
      createdAt: new Date().toISOString(),
    } as never);
    renderDrawer([testBinding]);

    const button = await screen.findByTestId('execution-start-button');
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByTestId('task-project-binding-link')).not.toBeInTheDocument();
    await user.click(button);
    await waitFor(() => expect(api.startTask).toHaveBeenCalledWith('task_audit'));
  });
});
