import { test, expect } from '../../fixtures';
import { expectSuccessToast, gotoPath } from '../../support/app';
import { bySelector, byTestId } from '../../support/ui-contract';

test.describe('execution functional flows', () => {
  test('starts a deterministic execution, streams progress/logs, and completes the task', async ({
    page,
    factory,
  }) => {
    await factory.setRuntimeMode('manual');
    const agent = await factory.createAgent();
    const task = await factory.createTask({
      title: factory.uniqueName('Stream deterministic execution'),
      assigneeAgentId: agent.id,
    });

    await gotoPath(page, `/tasks?task=${task.id}`);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.start')).toBeEnabled();
    await byTestId(page, 'taskDetail.start').click();

    await page.waitForURL(/\/executions\/[^/?]+$/);
    const executionId = page.url().split('/').pop() as string;
    const banner = byTestId(page, 'execution.statusBanner');
    await expect(banner).toHaveAttribute('data-status', 'running');
    await expect(byTestId(page, 'execution.stop')).toBeVisible();
    await expect(byTestId(page, 'execution.log')).toBeVisible();
    await expect(byTestId(page, 'execution.logEntry')).toHaveCount(1);
    await expect(byTestId(page, 'execution.logEntry').first()).toContainText(
      'Mock runtime attached',
    );

    await factory.advanceExecution(executionId, 2);
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute('aria-valuenow', '40');
    await expect(byTestId(page, 'execution.progressValue')).toHaveText('40');
    await expect(byTestId(page, 'execution.logEntry')).toHaveCount(3);

    await factory.finishExecution(executionId, 'success');
    await expect(banner).toHaveAttribute('data-status', 'completed');
    await expect(byTestId(page, 'execution.stop')).toHaveCount(0);
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute('aria-valuenow', '100');
    await expect(byTestId(page, 'execution.logLiveStatus')).toContainText('Stream complete');

    await expect
      .poll(async () => (await factory.getExecution(executionId)).status)
      .toBe('completed');
    const storedTask = await factory.getTask(task.id);
    expect(storedTask.status).toBe('done');
    const storedAgent = await factory.getAgent(agent.id);
    expect(storedAgent.status).toBe('idle');
    const logs = await factory.getExecutionLogs(executionId);
    expect(logs.items.length).toBeGreaterThanOrEqual(3);
    expect(logs.items.at(-1)?.level).toBe('success');
  });

  test('cancels a running execution through the confirmation dialog', async ({
    page,
    factory,
  }) => {
    await factory.setRuntimeMode('manual');
    const { agent, task, execution } = await factory.createRunningExecution({
      task: { title: factory.uniqueName('Cancel deterministic execution') },
    });

    await gotoPath(page, `/executions/${execution.id}`);
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'running',
    );

    await byTestId(page, 'execution.stop').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Cancel this execution?');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await factory.getExecution(execution.id)).status).toBe('running');

    await byTestId(page, 'execution.stop').click();
    await byTestId(page, 'execution.stopConfirm').click();
    await expectSuccessToast(page, 'Execution cancelled');
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'cancelled',
    );
    await expect(byTestId(page, 'execution.cancelReason')).toContainText(
      'Cancelled from execution detail',
    );
    await expect(byTestId(page, 'execution.stop')).toHaveCount(0);

    await expect
      .poll(async () => (await factory.getExecution(execution.id)).status)
      .toBe('cancelled');
    expect((await factory.getTask(task.id)).status).toBe('cancelled');
    expect((await factory.getAgent(agent.id)).status).toBe('idle');
  });

  test('renders a failed execution with its failure reason and error log', async ({
    page,
    factory,
  }) => {
    await factory.setRuntimeMode('manual');
    const { task, agent, execution } = await factory.createRunningExecution({
      task: { title: factory.uniqueName('Fail deterministic execution') },
    });
    const reason = 'Toolchain unavailable in the workspace container';
    await factory.finishExecution(execution.id, 'failure', reason);
    await expect
      .poll(async () => (await factory.getExecution(execution.id)).status)
      .toBe('failed');

    await gotoPath(page, `/executions/${execution.id}`);
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'failed',
    );
    await expect(byTestId(page, 'execution.failureReason')).toContainText(reason);
    await expect(byTestId(page, 'execution.stop')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="execution-log-entry"][data-level="error"]'),
    ).toContainText(reason);

    expect((await factory.getTask(task.id)).status).toBe('failed');
    expect((await factory.getAgent(agent.id)).status).toBe('error');
  });

  test('shows seeded execution history, task link, and accessible log semantics', async ({
    page,
  }) => {
    await gotoPath(page, '/executions/execution_seed_completed');
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'completed',
    );
    await expect(bySelector(page, 'execution.log')).toBeVisible();
    await expect(byTestId(page, 'execution.logEntry')).toHaveCount(5);
    await expect(byTestId(page, 'execution.taskCard')).toContainText(
      'Scaffold the Raft Lite workspace shell',
    );

    await byTestId(page, 'execution.taskLink').click();
    await page.waitForURL(/\/tasks\?task=task_workspace_shell/);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.panel')).toContainText(
      'Scaffold the Raft Lite workspace shell',
    );
  });
});
