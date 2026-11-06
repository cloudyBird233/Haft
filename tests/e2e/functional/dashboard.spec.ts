import { test, expect } from '../../fixtures';
import {
  failRequestsUntilRetry,
  expectSuccessToast,
  gotoRoute,
  toast,
} from '../../support/app';
import { bySelector, byTestId } from '../../support/ui-contract';

test.describe('dashboard functional flows', () => {
  test('renders workspace metrics, recent tasks, activity, and agent status', async ({ page }) => {
    await gotoRoute(page, 'dashboard');
    await expect(byTestId(page, 'dashboard.statAgents')).toContainText('3');
    await expect(byTestId(page, 'dashboard.statOnline')).toContainText('3');
    await expect(byTestId(page, 'dashboard.statRunning')).toContainText('0');
    await expect(byTestId(page, 'dashboard.statCompleted')).toContainText('1');

    await expect(byTestId(page, 'dashboard.recentTask')).toHaveCount(4);
    await expect(byTestId(page, 'dashboard.activity')).toHaveCount(4);
    await expect(byTestId(page, 'dashboard.agentRow')).toHaveCount(3);
    await expect(byTestId(page, 'dashboard.agentStatus').first()).toHaveAttribute(
      'data-status',
      'idle',
    );
    await expect(byTestId(page, 'dashboard.runtimeCard')).toContainText('Mock runtime');

    await bySelector(page, 'dashboard.refresh').click();
    await expectSuccessToast(page, 'Overview refreshed');
  });

  test('navigates between the three primary routes', async ({ page }) => {
    await gotoRoute(page, 'dashboard');

    await bySelector(page, 'shell.navAgents').click();
    await page.waitForURL(/\/agents$/);
    await expect(byTestId(page, 'agents.page')).toBeVisible();

    await bySelector(page, 'shell.navTasks').click();
    await page.waitForURL(/\/tasks$/);
    await expect(byTestId(page, 'tasks.page')).toBeVisible();

    await bySelector(page, 'shell.navOverview').click();
    await page.waitForURL(/\/$/);
    await expect(byTestId(page, 'dashboard.page')).toBeVisible();
  });

  test('opens the task creation dialog from the dashboard action', async ({ page }) => {
    await gotoRoute(page, 'dashboard');
    await bySelector(page, 'dashboard.newTask').click();
    await page.waitForURL(/\/tasks/);
    await expect(byTestId(page, 'taskForm.dialog')).toBeVisible();
    await byTestId(page, 'taskForm.cancel').click();
    await expect(page).toHaveURL(/\/tasks$/);
  });

  test('shows the empty workspace states for the empty seed', async ({ page, factory }) => {
    await factory.reset('empty');
    await gotoRoute(page, 'dashboard');
    await expect(byTestId(page, 'dashboard.statAgents')).toContainText('3');
    await expect(byTestId(page, 'dashboard.statCompleted')).toContainText('0');
    await expect(byTestId(page, 'dashboard.tasksEmpty')).toBeVisible();
    await expect(byTestId(page, 'dashboard.activityEmpty')).toBeVisible();
    await expect(byTestId(page, 'dashboard.recentTask')).toHaveCount(0);
    await expect(byTestId(page, 'dashboard.activity')).toHaveCount(0);
  });

  test('renders a recoverable error when the dashboard request fails', async ({ page }) => {
    const failure = await failRequestsUntilRetry(page, '**/api/dashboard*');
    await gotoRoute(page, 'dashboard');
    await expect(byTestId(page, 'dashboard.error')).toBeVisible();
    await expect(byTestId(page, 'dashboard.error')).toContainText('Overview is unavailable');

    failure.stopFailing();
    await bySelector(page, 'dashboard.retry').click();
    await expect(byTestId(page, 'dashboard.statAgents')).toBeVisible();
    await expect(byTestId(page, 'dashboard.error')).toHaveCount(0);
  });

  test('keeps the error toast variant when a refresh fails', async ({ page }) => {
    await gotoRoute(page, 'dashboard');
    await expect(byTestId(page, 'dashboard.statAgents')).toBeVisible();

    await page.route('**/api/dashboard*', (routeHandler) =>
      routeHandler.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'E2E_REFRESH_FAILURE', message: 'Refresh failed for E2E coverage' },
          requestId: 'e2e-refresh',
        }),
      }),
    );
    await bySelector(page, 'dashboard.refresh').click();
    await expect(toast(page, 'Could not refresh overview')).toBeVisible();
    await expect(toast(page, 'Could not refresh overview')).toHaveAttribute(
      'data-variant',
      'error',
    );
  });
});
