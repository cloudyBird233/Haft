import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectFormDialog,
  type ProjectFormSubmission,
} from '../features/projects/project-form-dialog';
import { ApiError } from '../services/api';
import { testProject } from './fixtures';

describe('ProjectFormDialog', () => {
  it('creates a project with a normalised key and repository metadata', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: ProjectFormSubmission) => Promise<void>>().mockResolvedValue();
    const onOpenChange = vi.fn();
    render(
      <ProjectFormDialog open onOpenChange={onOpenChange} mode="create" onSubmit={onSubmit} />,
    );

    await user.type(screen.getByTestId('project-key-input'), 'haft');
    await user.type(screen.getByTestId('project-name-input'), 'Haft Platform');
    await user.type(screen.getByTestId('project-repo-url-input'), 'not a url');
    await user.click(screen.getByTestId('project-submit-button'));
    expect(
      await screen.findByText(
        'Repository URL must be an http(s), ssh, git URL, or git@host:path address',
      ),
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(screen.getByTestId('project-repo-url-input'));
    await user.type(screen.getByTestId('project-repo-url-input'), 'git@github.com:org/haft.git');
    await user.click(screen.getByTestId('project-submit-button'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      key: 'HAFT',
      name: 'Haft Platform',
      description: '',
      color: '#6b7280',
      repoUrl: 'git@github.com:org/haft.git',
      defaultBranch: 'main',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('edits an existing project without exposing the immutable key', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: ProjectFormSubmission) => Promise<void>>().mockResolvedValue();
    render(
      <ProjectFormDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        initial={{ ...testProject, repoUrl: 'git@github.com:org/haft.git' }}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByTestId('project-key-input')).toBeDisabled();
    expect(screen.getByTestId('project-key-input')).toHaveValue('RAFT');
    expect(screen.getByTestId('project-default-branch-input')).toHaveValue('main');

    await user.clear(screen.getByTestId('project-name-input'));
    await user.type(screen.getByTestId('project-name-input'), 'Haft 2.0');
    await user.clear(screen.getByTestId('project-default-branch-input'));
    await user.type(screen.getByTestId('project-default-branch-input'), 'release/2026');
    await user.click(screen.getByTestId('project-submit-button'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'RAFT',
        name: 'Haft 2.0',
        defaultBranch: 'release/2026',
        repoUrl: 'git@github.com:org/haft.git',
      }),
    );
  });

  it('surfaces API conflicts without closing the dialog', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(values: ProjectFormSubmission) => Promise<void>>().mockRejectedValue(
      new ApiError('Project key HAFT is already used in this workspace', {
        code: 'PROJECT_KEY_CONFLICT',
        status: 409,
      }),
    );
    const onOpenChange = vi.fn();
    render(
      <ProjectFormDialog open onOpenChange={onOpenChange} mode="create" onSubmit={onSubmit} />,
    );

    await user.type(screen.getByTestId('project-key-input'), 'HAFT');
    await user.type(screen.getByTestId('project-name-input'), 'Duplicate Project');
    await user.click(screen.getByTestId('project-submit-button'));

    expect(await screen.findByTestId('project-form-error')).toHaveTextContent(
      'Project key HAFT is already used in this workspace',
    );
    expect(screen.getByTestId('project-form')).toHaveAttribute('data-state', 'error');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
