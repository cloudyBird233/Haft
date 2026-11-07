import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { RuntimeAvailabilityDto } from '@raft-lite/contracts';
import { RaftTestFactory } from '../fixtures/test-data-factory';
import { gotoPath } from '../support/app';
import { byTestId } from '../support/ui-contract';

const API_URL = process.env.REAL_E2E_API_URL ?? 'http://127.0.0.1:3201';
const COMPUTER_ID = 'computer_local';
const PROJECT_ID = 'project_demo';
const WORKTREE_ROOT = join(process.cwd(), 'test-results', 'real-e2e', 'worktrees');
const PROJECT_ROOT = join(process.cwd(), 'test-results', 'real-e2e', 'workspace');
const MARKER_FILE = 'HAFT_REAL_UI_E2E.md';

function factoryFor(request: APIRequestContext): RaftTestFactory {
  return new RaftTestFactory(request, { apiBaseUrl: API_URL });
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', PROJECT_ROOT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

async function waitForRuntime(
  factory: RaftTestFactory,
  runtime: 'codex' | 'opencode',
): Promise<RuntimeAvailabilityDto | null> {
  let last: RuntimeAvailabilityDto | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { items } = await factory.getRuntimes({
      computerId: COMPUTER_ID,
      projectId: PROJECT_ID,
    });
    last = items.find((item) => item.runtime === runtime) ?? null;
    if (last?.available) return last;
    if (
      last &&
      last.reasonCode !== 'RUNNER_NOT_REGISTERED' &&
      last.reasonCode !== 'RUNNER_OFFLINE'
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

/**
 * Opt-in end-to-end proof for Phase 1.1:
 *
 * - the real browser UI creates an agent and a task,
 * - the task starts a real Codex CLI through the real runner protocol,
 * - the live log and status views reach a terminal state,
 * - the Changes tab renders the persisted unified diff,
 * - the primary checkout, its HEAD and its remote configuration are untouched.
 *
 * It requires HAFT_REAL_CLI_E2E=1 and an installed/authenticated Codex CLI.
 */
test.describe('Real Codex UI execution (opt-in)', () => {
  test('creates data in the UI, runs the real CLI, and shows the diff without touching the primary checkout', async ({
    page,
    request,
  }) => {
    test.skip(
      process.env.HAFT_REAL_CLI_E2E !== '1',
      'Set HAFT_REAL_CLI_E2E=1 to run real CLI tests against installed and authenticated CLIs.',
    );

    const factory = factoryFor(request);
    await factory.reset('default');

    const capability = await waitForRuntime(factory, 'codex');
    test.skip(
      !capability?.available,
      `Real Codex CLI is unavailable: ${capability?.reasonCode ?? 'UNKNOWN'} ${capability?.reason ?? ''}`,
    );
    if (!capability?.available) return;

    const baselineHead = git(['rev-parse', 'HEAD']);
    const baselineStatus = git(['status', '--porcelain']);
    const baselineCommits = git(['rev-list', '--count', 'HEAD']);
    const baselineRemotes = git(['remote']);
    expect(baselineStatus).toBe('');

    // 1. Create a Codex agent through the real UI.
    const agentName = factory.uniqueName('Real Codex UI Agent');
    await gotoPath(page, '/agents');
    await byTestId(page, 'agents.create').click();
    await expect(byTestId(page, 'agentForm.dialog')).toBeVisible();
    await byTestId(page, 'agentForm.name').fill(agentName);
    await byTestId(page, 'agentForm.role').fill('Real CLI Steward');
    await byTestId(page, 'agentForm.description').fill(
      'Runs one real Codex execution in a disposable worktree.',
    );
    await byTestId(page, 'agentForm.runtime').selectOption('codex');
    await byTestId(page, 'agentForm.computer').selectOption(COMPUTER_ID);
    await byTestId(page, 'agentForm.submit').click();
    await expect(byTestId(page, 'agentForm.dialog')).toHaveCount(0);
    await expect(
      byTestId(page, 'agents.card').filter({ hasText: agentName }),
    ).toBeVisible();

    const agent = (await factory.listAgents()).items.find((item) => item.name === agentName);
    expect(agent, 'The UI must persist the Codex agent').toBeDefined();
    if (!agent) return;
    expect(agent.runtime).toBe('codex');
    expect(agent.computerId).toBe(COMPUTER_ID);

    // 2. Create a task assigned to that agent through the real UI.
    const taskTitle = factory.uniqueName('Real Codex UI execution');
    await gotoPath(page, '/tasks');
    await byTestId(page, 'tasks.create').click();
    await expect(byTestId(page, 'taskForm.dialog')).toBeVisible();
    await byTestId(page, 'taskForm.title').fill(taskTitle);
    await byTestId(page, 'taskForm.description').fill(
      [
        `Create a file named ${MARKER_FILE} at the repository root.`,
        'It must contain exactly the text "real-ui-ok".',
        'Do not modify any other file. Do not commit, push, merge, or create branches.',
      ].join(' '),
    );
    await byTestId(page, 'taskForm.project').selectOption(PROJECT_ID);
    await byTestId(page, 'taskForm.assignee').selectOption(agent.id);
    await byTestId(page, 'taskForm.priority').selectOption('high');
    await byTestId(page, 'taskForm.submit').click();
    await expect(byTestId(page, 'taskForm.dialog')).toHaveCount(0);
    const taskCard = byTestId(page, 'taskBoard.card').filter({ hasText: taskTitle });
    await expect(taskCard).toHaveAttribute('data-status', 'claimed');

    const createdTask = (await factory.listTasks()).items.find(
      (item) => item.title === taskTitle,
    );
    expect(createdTask, 'The UI must persist the task').toBeDefined();
    if (!createdTask) return;

    // 3. Start the execution from task detail and watch the real process.
    await taskCard.click();
    await expect(byTestId(page, 'taskDetail.panel')).toBeVisible();
    await expect(byTestId(page, 'taskDetail.start')).toBeEnabled();
    await byTestId(page, 'taskDetail.start').click();
    await page.waitForURL(/\/executions\/[^/?]+$/);
    const executionId = page.url().split('/').pop() as string;

    const banner = byTestId(page, 'execution.statusBanner');
    await expect(banner).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await expect(
      byTestId(page, 'execution.logEntry').filter({
        hasText: 'Isolated Git worktree ready on branch',
      }),
    ).toHaveCount(1, { timeout: 120_000 });
    await expect(byTestId(page, 'execution.logEntry').first()).toBeVisible();

    await expect(banner).toHaveAttribute('data-status', 'completed', {
      timeout: 540_000,
    });
    await expect(byTestId(page, 'execution.progress')).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    await expect(byTestId(page, 'execution.stop')).toHaveCount(0);

    // 4. Verify the persisted execution, task and agent state through the API.
    const execution = await factory.getExecution(executionId);
    expect(execution.runtime).toBe('codex');
    expect(execution.phase).toBe('completed');
    expect(execution.status).toBe('completed');
    expect(execution.runnerId).toBe('runner_real_e2e');
    expect(execution.branchName).toBe(`haft/${executionId}`);
    expect(execution.baseCommit).toBe(baselineHead);
    expect(execution.exitCode).toBe(0);
    expect(execution.changedFiles).toBeGreaterThanOrEqual(1);
    expect(execution.diffTruncated).toBe(false);
    expect((await factory.getTask(createdTask.id)).status).toBe('done');
    expect((await factory.getAgent(agent.id)).status).toBe('idle');

    const diff = await factory.getExecutionDiff(executionId);
    expect(diff.available).toBe(true);
    expect(diff.branchName).toBe(`haft/${executionId}`);
    expect(diff.baseCommit).toBe(baselineHead);
    // The CLI must not commit: the worktree HEAD stays on the base commit.
    expect(diff.headCommit).toBe(baselineHead);
    expect(diff.diffTruncated).toBe(false);
    expect(diff.changedFiles).toBeGreaterThanOrEqual(1);
    expect(diff.diff).toContain(`+++ b/${MARKER_FILE}`);
    expect(diff.diff).toContain('+real-ui-ok');

    // 5. Render the Changes tab from the persisted artifact.
    await byTestId(page, 'execution.changesTab').click();
    await expect(byTestId(page, 'execution.diffPanel')).toBeVisible();
    await expect(byTestId(page, 'execution.changedFiles')).toBeVisible();
    const fileCard = page.locator(
      `[data-testid="execution-diff-file"][data-path="${MARKER_FILE}"]`,
    );
    await expect(fileCard).toHaveAttribute('data-status', 'added');
    await expect(fileCard.getByTestId('execution-diff-content')).toContainText('real-ui-ok');
    await expect(byTestId(page, 'execution.diffTruncated')).toHaveAttribute(
      'data-truncated',
      'false',
    );
    await expect(page.getByTestId('execution-diff-branch')).toContainText(
      `haft/${executionId}`,
    );
    await expect(page.getByTestId('execution-diff-base')).toHaveText(baselineHead);

    // 6. Prove the worktree has the change and the primary checkout does not.
    const worktreeFile = join(WORKTREE_ROOT, PROJECT_ID, executionId, MARKER_FILE);
    expect(existsSync(worktreeFile), `Expected ${worktreeFile} to exist`).toBe(true);
    expect(readFileSync(worktreeFile, 'utf8')).toContain('real-ui-ok');
    expect(
      existsSync(join(PROJECT_ROOT, MARKER_FILE)),
      'The CLI must not modify the primary checkout',
    ).toBe(false);
    expect(git(['rev-parse', 'HEAD'])).toBe(baselineHead);
    expect(git(['rev-list', '--count', 'HEAD'])).toBe(baselineCommits);
    expect(git(['status', '--porcelain'])).toBe(baselineStatus);
    expect(git(['remote'])).toBe(baselineRemotes);
    // The runner created a dedicated branch at the base commit, but never
    // moved it: no commit, merge or push happened.
    expect(git(['rev-parse', `refs/heads/haft/${executionId}`])).toBe(baselineHead);
  });
});
