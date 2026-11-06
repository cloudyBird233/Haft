import { test, expect } from '../../fixtures';
import {
  expectSuccessToast,
  gotoPath,
  gotoRoute,
  laneCount,
  openTask,
  taskCard,
  waitForBoard,
} from '../../support/app';
import { byTestId } from '../../support/ui-contract';

test.describe('tasks functional flows', () => {
  test('renders the five-lane board with exact task statuses and counts', async ({ page }) => {
    await gotoRoute(page, 'tasks');
    await waitForBoard(page);

    await expect(laneCount(page, 'todo')).toHaveText('1');
    await expect(laneCount(page, 'active')).toHaveText('1');
    await expect(laneCount(page, 'review')).toHaveText('1');
    await expect(laneCount(page, 'done')).toHaveText('1');
    await expect(laneCount(page, 'stopped')).toHaveText('0');

    await expect(taskCard(page, 'Add live execution log viewer')).toHaveAttribute(
      'data-status',
      'todo',
    );
    await expect(taskCard(page, 'Define activity event contract')).toHaveAttribute(
      'data-status',
      'claimed',
    );
    await expect(taskCard(page, 'Review runtime adapter boundaries')).toHaveAttribute(
      'data-status',
      'in_review',
    );
    await expect(taskCard(page, 'Scaffold the Raft Lite workspace shell')).toHaveAttribute(
      'data-status',
      'done',
    );
    await expect(byTestId(page, 'taskBoard.laneEmpty', { lane: 'stopped' })).toBeVisible();
    await expect(byTestId(page, 'tasks.count')).toHaveText('4 tasks');
  });

  test('creates a task through the dialog and persists it in the active lane', async ({
    page,
    factory,
  }) => {
    await gotoRoute(page, 'tasks');
    await waitForBoard(page);

    await byTestId(page, 'tasks.create').click();
    const dialog = byTestId(page, 'taskForm.dialog');
    await expect(dialog).toBeVisible();
    await expect(byTestId(page, 'taskForm.title')).toBeFocused();

    const title = factory.uniqueName('Harden the execution log viewer');
    await byTestId(page, 'taskForm.title').fill(title);
    await byTestId(page, 'taskForm.description').fill(
      'Add keyboard navigation, live-region verification, and deterministic log replay.',
    );
    await byTestId(page, 'taskForm.project').selectOption('project_demo');
    await byTestId(page, 'taskForm.assignee').selectOption('agent_qa');
    await byTestId(page, 'taskForm.priority').selectOption('high');
    await byTestId(page, 'taskForm.submit').click();

    await expect(dialog).toHaveCount(0);
    await expectSuccessToast(page, 'Task created');
    const card = taskCard(page, title);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'claimed');
    await expect(laneCount(page, 'active')).toHaveText('2');

    const stored = (await factory.listTasks()).items.find((task) => task.title === title);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      title,
      status: 'claimed',
      priority: 'high',
      projectId: 'project_demo',
    });
    expect(stored?.assignee?.id).toBe('agent_qa');
  });

  test('searches and filters the board, including the empty filter result', async ({ page }) => {
    await gotoRoute(page, 'tasks');
    await waitForBoard(page);

    const search = byTestId(page, 'tasks.search');
    await search.fill('runtime adapter');
    await expect(byTestId(page, 'taskBoard.card')).toHaveCount(1);
    await expect(taskCard(page, 'Review runtime adapter boundaries')).toBeVisible();

    await search.fill('');
    await byTestId(page, 'tasks.statusFilter').selectOption('done');
    await expect(byTestId(page, 'taskBoard.card')).toHaveCount(1);
    await expect(taskCard(page, 'Scaffold the Raft Lite workspace shell')).toBeVisible();
    await byTestId(page, 'tasks.clearFilters').click();
    await expect(byTestId(page, 'taskBoard.card')).toHaveCount(4);

    await byTestId(page, 'tasks.priorityFilter').selectOption('low');
    await expect(byTestId(page, 'taskBoard.card')).toHaveCount(1);
    await expect(taskCard(page, 'Define activity event contract')).toBeVisible();
    await byTestId(page, 'tasks.clearFilters').click();

    await byTestId(page, 'tasks.assigneeFilter').selectOption('unassigned');
    await expect(byTestId(page, 'taskBoard.card')).toHaveCount(1);
    await expect(taskCard(page, 'Add live execution log viewer')).toBeVisible();
    await byTestId(page, 'tasks.clearFilters').click();

    await byTestId(page, 'tasks.projectFilter').selectOption('project_demo');
    await expect(byTestId(page, 'taskBoard.card')).toHaveCount(4);

    await search.fill('nothing-matches-this');
    await expect(byTestId(page, 'tasks.filterEmpty')).toBeVisible();
    await byTestId(page, 'tasks.clearFilters').click();
    await expect(byTestId(page, 'taskBoard.card')).toHaveCount(4);
  });

  test('moves a task through the next-status workflow and persists it', async ({
    page,
    factory,
  }) => {
    await gotoRoute(page, 'tasks');
    await waitForBoard(page);
    await openTask(page, 'Define activity event contract');

    const panel = byTestId(page, 'taskDetail.panel');
    await expect(panel).toContainText('Assigned agent');
    await byTestId(page, 'taskDetail.statusSelect').selectOption('in_progress');
    await byTestId(page, 'taskDetail.statusUpdate').click();

    await expectSuccessToast(page, 'Task status updated');
    await expect
      .poll(async () => (await factory.getTask('task_activity_contract')).status)
      .toBe('in_progress');

    await byTestId(page, 'dialog.close').click();
    await expect(taskCard(page, 'Define activity event contract')).toHaveAttribute(
      'data-status',
      'in_progress',
    );
  });

  test('assigns and unassigns an agent from task detail with API persistence', async ({
    page,
    factory,
  }) => {
    const task = await factory.createTask({
      title: factory.uniqueName('Triage flaky browser tests'),
      assigneeAgentId: null,
    });
    expect(task.status).toBe('todo');

    await gotoPath(page, `/tasks?task=${task.id}`);
    await waitForBoard(page);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();

    await byTestId(page, 'taskDetail.assigneeSelect').selectOption('agent_qa');
    await byTestId(page, 'taskDetail.assign').click();
    await expectSuccessToast(page, 'Assignment saved');
    await expect.poll(async () => (await factory.getTask(task.id)).assignee?.id).toBe('agent_qa');
    expect((await factory.getTask(task.id)).status).toBe('claimed');

    await byTestId(page, 'taskDetail.assigneeSelect').selectOption('');
    await byTestId(page, 'taskDetail.assign').click();
    await expect.poll(async () => (await factory.getTask(task.id)).assignee).toBeNull();
    expect((await factory.getTask(task.id)).status).toBe('todo');

    await byTestId(page, 'dialog.close').click();
    await expect(taskCard(page, task.title)).toHaveAttribute('data-status', 'todo');
  });

  test('edits a task brief and priority from the detail panel', async ({ page, factory }) => {
    const task = await factory.createTask({ title: factory.uniqueName('Draft onboarding guide') });
    const updatedTitle = factory.uniqueName('Publish onboarding guide');

    await gotoPath(page, `/tasks?task=${task.id}`);
    await waitForBoard(page);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await byTestId(page, 'taskDetail.edit').click();

    const dialog = byTestId(page, 'taskForm.dialog');
    await expect(dialog).toContainText('Edit task');
    await expect(byTestId(page, 'taskForm.title')).toHaveValue(task.title);
    await byTestId(page, 'taskForm.title').fill(updatedTitle);
    await byTestId(page, 'taskForm.priority').selectOption('urgent');
    await byTestId(page, 'taskForm.submit').click();

    await expectSuccessToast(page, 'Task updated');
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () => {
        const stored = await factory.getTask(task.id);
        return { title: stored.title, priority: stored.priority };
      })
      .toEqual({ title: updatedTitle, priority: 'urgent' });
    await expect(taskCard(page, updatedTitle)).toBeVisible();
  });

  test('cancels a task through the nested alert dialog and preserves it on Escape', async ({
    page,
    factory,
  }) => {
    const task = await factory.createTask({ title: factory.uniqueName('Cancelable cleanup') });
    await gotoPath(page, `/tasks?task=${task.id}`);
    await waitForBoard(page);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();

    await byTestId(page, 'taskDetail.cancelTask').click();
    const cancelDialog = page.getByRole('alertdialog');
    await expect(cancelDialog).toBeVisible();
    await expect(cancelDialog).toContainText('Cancel this task?');
    await page.keyboard.press('Escape');
    await expect(cancelDialog).toHaveCount(0);
    expect((await factory.getTask(task.id)).status).toBe('todo');

    await byTestId(page, 'taskDetail.cancelTask').click();
    await byTestId(page, 'taskCancel.confirm').click();
    await expectSuccessToast(page, 'Task cancelled');
    await expect.poll(async () => (await factory.getTask(task.id)).status).toBe('cancelled');

    await byTestId(page, 'dialog.close').click();
    await expect(taskCard(page, task.title)).toHaveAttribute('data-status', 'cancelled');
    await expect(laneCount(page, 'stopped')).toHaveText('1');
  });

  test('deletes a task only after explicit confirmation', async ({ page, factory }) => {
    const task = await factory.createTask({ title: factory.uniqueName('Remove duplicate task') });
    await gotoPath(page, `/tasks?task=${task.id}`);
    await waitForBoard(page);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();

    await byTestId(page, 'taskDetail.delete').click();
    const deleteDialog = page.getByRole('alertdialog');
    await expect(deleteDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(deleteDialog).toHaveCount(0);
    await expect.poll(async () => (await factory.getTask(task.id)).id).toBe(task.id);

    await byTestId(page, 'taskDetail.delete').click();
    await byTestId(page, 'taskDelete.confirm').click();
    await expectSuccessToast(page, 'Task deleted');
    await expect(byTestId(page, 'taskDetail.panel')).toHaveCount(0);
    await expect(taskCard(page, task.title)).toHaveCount(0);

    let notFound: unknown;
    try {
      await factory.getTask(task.id);
    } catch (error) {
      notFound = error;
    }
    expect(String(notFound)).toContain('TASK_NOT_FOUND');
  });

  test('shows the empty board for the empty seed and exposes the create action', async ({
    page,
    factory,
  }) => {
    await factory.reset('empty');
    await gotoRoute(page, 'tasks');
    await expect(byTestId(page, 'tasks.empty')).toBeVisible();
    await expect(byTestId(page, 'tasks.emptyCreate')).toBeVisible();
    await byTestId(page, 'tasks.emptyCreate').click();
    await expect(byTestId(page, 'taskForm.dialog')).toBeVisible();
    await byTestId(page, 'taskForm.cancel').click();
    await expect(byTestId(page, 'taskForm.dialog')).toHaveCount(0);
  });

  test('shows a task-not-found state for a deleted task id', async ({ page }) => {
    await gotoPath(page, '/tasks?task=task_that_does_not_exist');
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.notFound')).toBeVisible();
  });
});
