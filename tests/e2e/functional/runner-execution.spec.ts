import { test, expect } from '../../fixtures';
import type { RaftTestFactory } from '../../fixtures/test-data-factory';
import { gotoPath } from '../../support/app';
import { byTestId } from '../../support/ui-contract';

const COMPUTER_ID = 'computer_local';
const PROJECT_ID = 'project_demo';

/**
 * The Fake Runner is a real Socket.IO client that speaks the runner protocol
 * but executes deterministic, local steps instead of invoking a model. These
 * tests therefore cover the production server/runner/database/UI path while
 * remaining independent from CLI installation, authentication or model access.
 */
async function waitForFakeRunner(factory: RaftTestFactory): Promise<void> {
  await expect
    .poll(
      async () => {
        const { items } = await factory.getRuntimes({
          computerId: COMPUTER_ID,
          projectId: PROJECT_ID,
        });
        return items.find((item) => item.runtime === 'codex')?.available ?? false;
      },
      {
        timeout: 45_000,
        message:
          'The Fake Runner did not register for computer_local/project_demo. Start it with pnpm --filter @raft-lite/runner start.',
      },
    )
    .toBe(true);
}

test.describe('Fake Agent Runner', () => {
  test('runs a Codex execution through the runner protocol and completes the task', async ({
    page,
    factory,
  }) => {
    await waitForFakeRunner(factory);
    const agent = await factory.createAgent({
      name: factory.uniqueName('Runner Codex Agent'),
      runtime: 'codex',
      computerId: COMPUTER_ID,
    });
    const task = await factory.createTask({
      title: factory.uniqueName('Runner Codex execution'),
      description: 'Exercise the real server and runner transport without a real model.',
      projectId: PROJECT_ID,
      assigneeAgentId: agent.id,
    });

    await gotoPath(page, `/tasks?task=${task.id}`);
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.startHint')).toHaveCount(0);
    await expect(byTestId(page, 'taskDetail.start')).toBeEnabled();
    await byTestId(page, 'taskDetail.start').click();

    await page.waitForURL(/\/executions\/[^/?]+$/);
    const executionId = page.url().split('/').pop() as string;
    const banner = byTestId(page, 'execution.statusBanner');

    await expect(banner).toHaveAttribute('data-status', 'running');
    await expect(page.getByText(/Codex CLI runtime/).first()).toBeVisible();
    await expect(
      byTestId(page, 'execution.logEntry').filter({
        hasText: 'Fake runner accepted codex execution.',
      }),
    ).toHaveCount(1);

    await expect(banner).toHaveAttribute('data-status', 'completed', { timeout: 20_000 });
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute('aria-valuenow', '100');
    await expect(byTestId(page, 'execution.stop')).toHaveCount(0);

    await expect
      .poll(async () => (await factory.getExecution(executionId)).status)
      .toBe('completed');

    const execution = await factory.getExecution(executionId);
    expect(execution.runtime).toBe('codex');
    expect(execution.phase).toBe('completed');
    expect(execution.runnerId).toBe('runner_e2e');
    expect(execution.branchName).toBe(`haft/${executionId}`);
    expect(execution.exitCode).toBe(0);
    expect((await factory.getTask(task.id)).status).toBe('done');
    expect((await factory.getAgent(agent.id)).status).toBe('idle');

    const logs = await factory.getExecutionLogs(executionId);
    expect(logs.items.some((entry) => entry.message.includes('Fake runner completed all simulated steps.'))).toBe(
      true,
    );
    expect(new Set(logs.items.map((entry) => entry.seq)).size).toBe(logs.items.length);
  });

  test('waits for the Fake Runner to confirm a cancellation', async ({ page, factory }) => {
    await waitForFakeRunner(factory);
    const agent = await factory.createAgent({
      name: factory.uniqueName('Runner Cancel Agent'),
      runtime: 'codex',
      computerId: COMPUTER_ID,
    });
    const task = await factory.createTask({
      title: factory.uniqueName('Runner cancellation'),
      description: 'Cancel a runner execution and wait for the protocol acknowledgement.',
      projectId: PROJECT_ID,
      assigneeAgentId: agent.id,
    });
    const execution = await factory.startTask(task.id);

    await gotoPath(page, `/executions/${execution.id}`);
    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'running',
    );

    await byTestId(page, 'execution.stop').click();
    await expect(byTestId(page, 'execution.stopDialog')).toBeVisible();
    await byTestId(page, 'execution.stopConfirm').click();

    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'cancelled',
      { timeout: 20_000 },
    );
    await expect(byTestId(page, 'execution.cancelReason')).toContainText(
      'Cancelled from execution detail',
    );

    const cancelled = await factory.getExecution(execution.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.runnerId).toBe('runner_e2e');
    expect((await factory.getTask(task.id)).status).toBe('cancelled');
    expect((await factory.getAgent(agent.id)).status).toBe('idle');

    const logs = await factory.getExecutionLogs(execution.id);
    expect(logs.items.some((entry) => entry.message.includes('Cancellation requested:'))).toBe(
      true,
    );
  });

  test('propagates a deterministic Fake Runner failure to the task and agent', async ({
    page,
    factory,
  }) => {
    await waitForFakeRunner(factory);
    const agent = await factory.createAgent({
      name: factory.uniqueName('Runner Failure Agent'),
      runtime: 'opencode',
      computerId: COMPUTER_ID,
    });
    const task = await factory.createTask({
      title: factory.uniqueName('Runner failure [fail]'),
      description: 'The deterministic runner failure path must reach the UI.',
      projectId: PROJECT_ID,
      assigneeAgentId: agent.id,
    });

    await gotoPath(page, `/tasks?task=${task.id}`);
    await expect(byTestId(page, 'taskDetail.start')).toBeEnabled();
    await byTestId(page, 'taskDetail.start').click();
    await page.waitForURL(/\/executions\/[^/?]+$/);
    const executionId = page.url().split('/').pop() as string;

    await expect(byTestId(page, 'execution.statusBanner')).toHaveAttribute(
      'data-status',
      'failed',
      { timeout: 20_000 },
    );
    await expect(byTestId(page, 'execution.failureReason')).toContainText(
      'FAKE_RUNNER_FAILURE',
    );

    const execution = await factory.getExecution(executionId);
    expect(execution.runtime).toBe('opencode');
    expect(execution.phase).toBe('failed');
    expect(execution.runnerId).toBe('runner_e2e');
    expect(execution.exitCode).toBe(2);
    expect((await factory.getTask(task.id)).status).toBe('failed');
    expect((await factory.getAgent(agent.id)).status).toBe('error');
  });
});
