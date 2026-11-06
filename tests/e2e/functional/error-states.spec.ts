import { test, expect } from '../../fixtures';
import {
  failRequestsUntilRetry,
  gotoPath,
  gotoRoute,
  waitForAgentList,
  waitForBoard,
} from '../../support/app';
import { byTestId } from '../../support/ui-contract';

const inducedErrorBody = (code: string, message: string): string =>
  JSON.stringify({
    error: { code, message },
    requestId: 'e2e-induced-error',
  });

test.describe('functional error states', () => {
  test('agent list failure shows an error state and recoverable retry', async ({ page }) => {
    const failure = await failRequestsUntilRetry(page, '**/api/agents*');
    await gotoRoute(page, 'agents');
    await expect(byTestId(page, 'agents.error')).toBeVisible();
    await expect(byTestId(page, 'agents.error')).toContainText('Agents could not be loaded');

    failure.stopFailing();
    await byTestId(page, 'agents.retry').click();
    await waitForAgentList(page);
    await expect(byTestId(page, 'agents.error')).toHaveCount(0);
  });

  test('task board failure shows an error state and recoverable retry', async ({ page }) => {
    const failure = await failRequestsUntilRetry(page, '**/api/tasks*');
    await gotoRoute(page, 'tasks');
    await expect(byTestId(page, 'tasks.error')).toBeVisible();
    await expect(byTestId(page, 'tasks.error')).toContainText('Tasks could not be loaded');

    failure.stopFailing();
    await byTestId(page, 'tasks.retry').click();
    await waitForBoard(page);
    await expect(byTestId(page, 'tasks.error')).toHaveCount(0);
  });

  test('agent creation server error is surfaced inside the open form', async ({
    page,
    factory,
  }) => {
    await page.route('**/api/agents', async (routeHandler) => {
      if (routeHandler.request().method() !== 'POST') {
        await routeHandler.continue();
        return;
      }
      await routeHandler.fulfill({
        status: 500,
        contentType: 'application/json',
        body: inducedErrorBody('AGENT_CREATE_FAILED', 'The workspace rejected this agent'),
      });
    });

    await gotoRoute(page, 'agents');
    await waitForAgentList(page);
    await byTestId(page, 'agents.create').click();
    await byTestId(page, 'agentForm.name').fill(factory.uniqueName('Rejected Agent'));
    await byTestId(page, 'agentForm.role').fill('Invalid Worker');
    await byTestId(page, 'agentForm.submit').click();

    await expect(byTestId(page, 'agentForm.error')).toBeVisible();
    await expect(byTestId(page, 'agentForm.error')).toContainText(
      'The workspace rejected this agent',
    );
    await expect(byTestId(page, 'agentForm.dialog')).toBeVisible();
    await byTestId(page, 'agentForm.cancel').click();
    await expect(byTestId(page, 'agentForm.dialog')).toHaveCount(0);
  });

  test('task detail load failure can be retried without closing the drawer', async ({ page }) => {
    const failure = await failRequestsUntilRetry(page, '**/api/tasks/task_log_viewer');
    await gotoPath(page, '/tasks?task=task_log_viewer');
    await expect(byTestId(page, 'taskDetail.error')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();

    failure.stopFailing();
    await byTestId(page, 'taskDetail.retry').click();
    await expect(byTestId(page, 'taskDetail.error')).toHaveCount(0);
    await expect(byTestId(page, 'taskDetail.panel')).toContainText(
      'Add live execution log viewer',
    );
  });

  test('offline agents are blocked from starting an execution', async ({ page, factory }) => {
    const agent = await factory.createAgent();
    await factory.setAgentStatus(agent.id, 'offline');
    const task = await factory.createTask({
      title: factory.uniqueName('Blocked offline execution'),
      assigneeAgentId: agent.id,
    });

    await gotoPath(page, `/tasks?task=${task.id}`);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.start')).toBeDisabled();
    await expect(byTestId(page, 'taskDetail.startHint')).toContainText(
      'The assigned agent is offline',
    );
  });

  test('execution detail failure recovers through the retry action', async ({ page, factory }) => {
    await factory.setRuntimeMode('manual');
    const { execution } = await factory.createRunningExecution({
      task: { title: factory.uniqueName('Execution error state') },
    });
    const failure = await failRequestsUntilRetry(
      page,
      new RegExp(`/api/executions/${execution.id}$`),
    );
    await gotoPath(page, `/executions/${execution.id}`);
    await expect(byTestId(page, 'execution.error')).toBeVisible();

    failure.stopFailing();
    await byTestId(page, 'execution.retry').click();
    await expect(byTestId(page, 'execution.error')).toHaveCount(0);
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'running',
    );
  });

  test('log stream failure exposes a focused retry action', async ({ page, factory }) => {
    await factory.setRuntimeMode('manual');
    const { execution } = await factory.createRunningExecution({
      task: { title: factory.uniqueName('Log stream error state') },
    });
    const failure = await failRequestsUntilRetry(
      page,
      new RegExp(`/api/executions/${execution.id}/logs`),
    );

    await gotoPath(page, `/executions/${execution.id}`);
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'running',
    );
    await expect(byTestId(page, 'execution.logError')).toBeVisible();

    failure.stopFailing();
    await page.getByRole('button', { name: 'Retry log stream' }).click();
    await expect(byTestId(page, 'execution.logError')).toHaveCount(0);
    await expect(byTestId(page, 'execution.logEntry').first()).toContainText(
      'Mock runtime attached',
    );
  });

  test('the execution page reports a missing execution', async ({ page }) => {
    await gotoPath(page, '/executions/execution_missing_for_e2e');
    await expect(byTestId(page, 'execution.error')).toBeVisible();
    await expect(byTestId(page, 'execution.page')).toBeVisible();
  });
});
