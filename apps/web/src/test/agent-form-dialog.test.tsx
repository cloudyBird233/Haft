import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentFormDialog, type AgentFormSubmission } from '../features/agents/agent-form-dialog';
import { ApiError } from '../services/api';
import { testComputer } from './fixtures';

describe('AgentFormDialog', () => {
  it('validates required fields and submits a complete agent payload', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: AgentFormSubmission) => Promise<void>>().mockResolvedValue();
    const onOpenChange = vi.fn();

    render(
      <AgentFormDialog
        open
        onOpenChange={onOpenChange}
        mode="create"
        computers={[testComputer]}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole('dialog')).toBeVisible();
    await user.click(screen.getByTestId('agent-submit-button'));
    expect(await screen.findByText('Name must be at least 2 characters')).toBeVisible();
    expect(await screen.findByText('Role must be at least 2 characters')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^Name/), 'Reviewer');
    await user.type(screen.getByLabelText(/^Role/), 'Code Reviewer');
    await user.type(screen.getByLabelText(/^Description/), 'Reviews changes for quality.');
    await user.selectOptions(screen.getByLabelText(/^Runtime/), 'mock');
    await user.click(screen.getByTestId('agent-submit-button'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Reviewer',
      role: 'Code Reviewer',
      description: 'Reviews changes for quality.',
      runtime: 'mock',
      computerId: 'computer_local',
    });
  });

  it('shows a server error and remains open', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<(values: AgentFormSubmission) => Promise<void>>()
      .mockRejectedValue(new ApiError('Agent name is reserved', { code: 'CONFLICT' }));

    render(
      <AgentFormDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        computers={[testComputer]}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/^Name/), 'Reviewer');
    await user.type(screen.getByLabelText(/^Role/), 'Code Reviewer');
    await user.click(screen.getByTestId('agent-submit-button'));

    expect(await screen.findByTestId('agent-form-error')).toHaveTextContent(
      'Agent name is reserved',
    );
    expect(screen.getByTestId('agent-form')).toHaveAttribute('data-state', 'error');
  });

  it('closes via the Escape key', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <AgentFormDialog
        open
        onOpenChange={onOpenChange}
        mode="create"
        computers={[testComputer]}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
