import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreateTaskInput } from '@raft-lite/contracts';
import { TaskFormDialog } from '../features/tasks/task-form-dialog';
import { testAgents, testProject } from './fixtures';

describe('TaskFormDialog', () => {
  it('validates the title and creates a task with the selected assignee and priority', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: CreateTaskInput) => Promise<void>>().mockResolvedValue();
    render(
      <TaskFormDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        projects={[testProject]}
        agents={testAgents}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByTestId('task-submit-button'));
    expect(await screen.findByText('Title must be at least 3 characters')).toBeVisible();

    await user.type(screen.getByLabelText(/^Title/), 'Ship the audit trail');
    await user.type(screen.getByLabelText(/^Description/), 'Store every user action.');
    await user.selectOptions(screen.getByLabelText(/^Assignee/), 'agent_developer');
    await user.selectOptions(screen.getByLabelText(/^Priority/), 'urgent');
    await user.click(screen.getByTestId('task-submit-button'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Ship the audit trail',
        description: 'Store every user action.',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_developer',
        priority: 'urgent',
      }),
    );
  });

  it('shows an error when the API rejects task creation', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<(values: CreateTaskInput) => Promise<void>>()
      .mockRejectedValue(new Error('Rejected'));
    render(
      <TaskFormDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        projects={[testProject]}
        agents={testAgents}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/^Title/), 'Ship the audit trail');
    await user.click(screen.getByTestId('task-submit-button'));
    expect(await screen.findByTestId('task-form-error')).toBeVisible();
    expect(screen.getByTestId('task-form')).toHaveAttribute('data-state', 'error');
  });
});
