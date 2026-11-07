import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { RuntimeAvailabilityDto } from '@raft-lite/contracts';
import { RaftTestFactory } from '../fixtures/test-data-factory';

const API_URL = process.env.REAL_E2E_API_URL ?? 'http://127.0.0.1:3201';
const COMPUTER_ID = 'computer_local';
const PROJECT_ID = 'project_demo';
const WORKTREE_ROOT = join(process.cwd(), 'test-results', 'real-e2e', 'worktrees');
const PROJECT_ROOT = join(process.cwd(), 'test-results', 'real-e2e', 'workspace');

function factoryFor(request: APIRequestContext): RaftTestFactory {
  return new RaftTestFactory(request, { apiBaseUrl: API_URL });
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

async function runRealCli(
  request: APIRequestContext,
  runtime: 'codex' | 'opencode',
  markerFile: string,
): Promise<void> {
  const factory = factoryFor(request);
  await factory.reset('default');

  const capability = await waitForRuntime(factory, runtime);
  test.skip(
    !capability?.available,
    `Real ${runtime} CLI is unavailable: ${capability?.reasonCode ?? 'UNKNOWN'} ${capability?.reason ?? ''}`,
  );
  if (!capability?.available) return;

  const agent = await factory.createAgent({
    name: factory.uniqueName(`Real ${runtime} Agent`),
    runtime,
    computerId: COMPUTER_ID,
  });
  const task = await factory.createTask({
    title: factory.uniqueName(`Real ${runtime} execution`),
    description: [
      `Create a file named ${markerFile} at the repository root.`,
      'It must contain exactly the text "real-cli-ok".',
      'Do not modify any other file. Do not commit, push, or merge.',
    ].join(' '),
    projectId: PROJECT_ID,
    assigneeAgentId: agent.id,
  });

  let execution = await factory.startTask(task.id);
  await expect
    .poll(
      async () => {
        execution = await factory.getExecution(execution.id);
        return execution.status;
      },
      { timeout: 540_000, intervals: [2000, 3000, 5000] },
    )
    .toMatch(/completed|failed|cancelled/);

  if (execution.status !== 'completed') {
    const logs = await factory.getExecutionLogs(execution.id);
    const tail = logs.items
      .slice(-15)
      .map((entry) => `${entry.level}: ${entry.message}`)
      .join('\n');
    expect(
      execution.status,
      `Real ${runtime} execution did not complete: ${execution.failureReason ?? 'no reason'}\n${tail}`,
    ).toBe('completed');
  }

  expect(execution.runtime).toBe(runtime);
  expect(execution.phase).toBe('completed');
  expect(execution.runnerId).toBe('runner_real_e2e');
  expect(execution.branchName).toBe(`haft/${execution.id}`);
  expect(execution.exitCode).toBe(0);
  expect(execution.summary?.trim().length ?? 0).toBeGreaterThan(0);
  expect((await factory.getTask(task.id)).status).toBe('done');
  expect((await factory.getAgent(agent.id)).status).toBe('idle');

  const worktreeFile = join(WORKTREE_ROOT, PROJECT_ID, execution.id, markerFile);
  expect(existsSync(worktreeFile), `Expected ${worktreeFile} to exist`).toBe(true);
  expect(readFileSync(worktreeFile, 'utf8')).toContain('real-cli-ok');
  expect(
    existsSync(join(PROJECT_ROOT, markerFile)),
    'The CLI must not modify the primary checkout',
  ).toBe(false);

  const logs = await factory.getExecutionLogs(execution.id);
  expect(
    logs.items.some((entry) =>
      entry.message.includes('Isolated Git worktree ready on branch haft/'),
    ),
  ).toBe(true);
  expect(
    logs.items.some((entry) => entry.message.includes('CLI process exited successfully.')),
  ).toBe(true);
  expect(new Set(logs.items.map((entry) => entry.seq)).size).toBe(logs.items.length);
}

test.describe('Real CLI execution (opt-in)', () => {
  test('runs a real Codex CLI in an isolated worktree', async ({ request }) => {
    test.skip(
      process.env.HAFT_REAL_CLI_E2E !== '1',
      'Set HAFT_REAL_CLI_E2E=1 to run real CLI tests against installed and authenticated CLIs.',
    );
    await runRealCli(request, 'codex', 'HAFT_REAL_E2E.md');
  });

  test('runs a real OpenCode CLI in an isolated worktree', async ({ request }) => {
    test.skip(
      process.env.HAFT_REAL_CLI_E2E !== '1',
      'Set HAFT_REAL_CLI_E2E=1 to run real CLI tests against installed and authenticated CLIs.',
    );
    test.skip(
      process.env.HAFT_REAL_E2E_OPENCODE !== '1',
      'Set HAFT_REAL_E2E_OPENCODE=1 and HAFT_REAL_OPENCODE_MODEL=<provider/model> to enable the OpenCode test.',
    );
    await runRealCli(request, 'opencode', 'HAFT_REAL_OPENCODE_E2E.md');
  });
});
