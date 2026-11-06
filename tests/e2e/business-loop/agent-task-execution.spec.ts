import { test, expect } from '../../fixtures';
import {
  expectSuccessToast,
  gotoRoute,
  taskCard,
  waitForAgentList,
  waitForBoard,
} from '../../support/app';
import { bySelector, byTestId } from '../../support/ui-contract';

test.describe('business loop', () => {
  test('agent creation, task routing, execution, completion, and dashboard propagation', async ({
    page,
    factory,
  }) => {
    const agentName = factory.uniqueName('Loop Steward');
    const taskTitle = factory.uniqueName('Ship the end-to-end loop');

    // 1. Create an agent through the UI.
    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await byTestId(page, 'agents.create').click();
    await byTestId(page, 'agentForm.name').fill(agentName);
    await byTestId(page, 'agentForm.role').fill('Delivery Steward');
    await byTestId(page, 'agentForm.description').fill(
      'Coordinates delivery from task intake to a verified execution.',
    );
    await byTestId(page, 'agentForm.submit').click();
    await expectSuccessToast(page, 'Agent created');
    await expect(byTestId(page, 'agents.card').filter({ hasText: agentName })).toBeVisible();

    const agent = (await factory.listAgents()).items.find((item) => item.name === agentName);
    expect(agent).toBeDefined();
    if (!agent) throw new Error('Agent was not persisted by the create flow');

    // 2. Create a task and route it to the new agent through the UI.
    await bySelector(page, 'shell.navTasks').click();
    await waitForBoard(page);
    await byTestId(page, 'tasks.create').click();
    await byTestId(page, 'taskForm.title').fill(taskTitle);
    await byTestId(page, 'taskForm.description').fill(
      'Deliver the complete business loop with API persistence at every step.',
    );
    await byTestId(page, 'taskForm.project').selectOption('project_demo');
    await byTestId(page, 'taskForm.assignee').selectOption(agent.id);
    await byTestId(page, 'taskForm.priority').selectOption('high');
    await byTestId(page, 'taskForm.submit').click();
    await expectSuccessToast(page, 'Task created');
    await expect(taskCard(page, taskTitle)).toHaveAttribute('data-status', 'claimed');

    const createdTask = (await factory.listTasks()).items.find((task) => task.title === taskTitle);
    expect(createdTask).toBeDefined();
    if (!createdTask) throw new Error('Task was not persisted by the create flow');

    // 3. Start a deterministic execution from task detail.
    await factory.setRuntimeMode('manual');
    await taskCard(page, taskTitle).click();
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await byTestId(page, 'taskDetail.start').click();
    await page.waitForURL(/\/executions\/[^/?]+$/);
    const executionId = page.url().split('/').pop() as string;

    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'running',
    );
    await expect(byTestId(page, 'execution.logEntry')).toHaveCount(1);

    // 4. Advance the deterministic runtime and observe live progress.
    await factory.advanceExecution(executionId, 2);
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute('aria-valuenow', '40');
    await expect(byTestId(page, 'execution.logEntry')).toHaveCount(3);

    // 5. Finish the execution and verify the task reaches Done.
    await factory.finishExecution(executionId, 'success');
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'completed',
    );
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute('aria-valuenow', '100');
    await expect(byTestId(page, 'execution.logLiveStatus')).toContainText('Stream complete');

    await byTestId(page, 'execution.back').click();
    await waitForBoard(page);
    await expect(taskCard(page, taskTitle)).toHaveAttribute('data-status', 'done');
    await taskCard(page, taskTitle).click();
    await expect(byTestId(page, 'taskDetail.panel')).toContainText('Done');
    await expect(byTestId(page, 'taskDetail.executionHistory')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.executionRow')).toHaveCount(1);
    await byTestId(page, 'dialog.close').click();

    // 6. Confirm the same state propagates to the dashboard and the API.
    await bySelector(page, 'shell.navOverview').click();
    await expect(byTestId(page, 'dashboard.statCompleted')).toContainText('2');
    await expect(byTestId(page, 'dashboard.statRunning')).toContainText('0');
    await expect(byTestId(page, 'dashboard.recentTask').filter({ hasText: taskTitle })).toHaveCount(
      1,
    );
    await expect(
      byTestId(page, 'dashboard.activity').filter({ hasText: taskTitle }).first(),
    ).toContainText('completed');

    const finalExecution = await factory.getExecution(executionId);
    expect(finalExecution.status).toBe('completed');
    expect((await factory.getTask(createdTask.id)).status).toBe('done');
    expect((await factory.getAgent(agent.id)).status).toBe('idle');
  });
});
