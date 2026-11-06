import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskBoard } from '../features/tasks/task-board';
import { testTasks } from './fixtures';

describe('TaskBoard', () => {
  it('renders every lane and exposes the exact status on each card', () => {
    render(<TaskBoard tasks={testTasks} onOpen={vi.fn()} />);

    expect(screen.getByTestId('task-board')).toBeVisible();
    for (const lane of ['todo', 'active', 'review', 'done', 'stopped']) {
      expect(screen.getByTestId(`task-lane-${lane}`)).toBeVisible();
    }
    expect(screen.getByTestId(`task-lane-active-count`)).toHaveTextContent('1');
    expect(screen.getAllByTestId('task-card')).toHaveLength(2);
  });

  it('opens a task through an accessible button and shows an empty lane state', async () => {
    const onOpen = vi.fn();
    render(<TaskBoard tasks={testTasks} onOpen={onOpen} />);
    screen.getByRole('button', { name: 'Open task Audit log viewer' }).click();
    expect(onOpen).toHaveBeenCalledWith('task_audit');
    expect(screen.getByTestId('task-lane-done-empty')).toBeVisible();
  });
});
