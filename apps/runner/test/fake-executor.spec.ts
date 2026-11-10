import { describe, expect, it } from 'vitest';
import type {
  ExecutionPhase,
  ExecutionStartMessage,
  GitExecutionResult,
  RunnerLogEntry,
} from '@raft-lite/contracts';
import type { RunnerConfig } from '../src/config';
import {
  FakeExecutor,
  type CancelledPayload,
  type CompletedPayload,
  type FailedPayload,
} from '../src/fake-executor';

interface Captured {
  phases: Array<{ executionId: string; phase: ExecutionPhase; message?: string | null }>;
  logs: Array<{ executionId: string; entry: RunnerLogEntry }>;
  progress: Array<{ executionId: string; progress: number; step: number }>;
  completed: Array<{ executionId: string; payload: CompletedPayload }>;
  failed: Array<{ executionId: string; payload: FailedPayload }>;
  cancelled: Array<{ executionId: string; payload: CancelledPayload }>;
}

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    serverUrl: 'http://127.0.0.1:3001',
    runnerId: 'runner_test',
    computerId: 'computer_local',
    bootstrapToken: 'test-bootstrap-token',
    tokenFile: 'runner-test-token.json',
    mode: 'fake',
    fakeRuntimes: ['codex', 'opencode'],
    realRuntimes: [],
    cliPaths: {},
    cliModels: {},
    gitBinary: 'git',
    worktreeRoot: process.cwd(),
    keepWorktrees: true,
    recoveryRoot: process.cwd(),
    shutdownGraceMs: 3000,
    cliTimeoutMs: 60_000,
    allowAutoApprove: false,
    allowedRepositoryRoots: [],
    allowUnc: false,
    stepMs: 15,
    healthPort: 0,
    maxConcurrentExecutions: 1,
    runnerVersion: '0.1.0',
    platform: process.platform,
    architecture: process.arch,
    ...overrides,
  };
}

function startPayload(
  overrides: Partial<ExecutionStartMessage['payload']> = {},
): ExecutionStartMessage['payload'] {
  return {
    executionId: 'execution_runner_test',
    runtime: 'codex',
    taskId: 'task_runner_test',
    taskTitle: 'Exercise the fake runner',
    taskDescription: 'A deterministic task for runner unit tests.',
    projectId: 'project_demo',
    prompt: 'Do the task.',
    options: {},
    ...overrides,
  };
}

function createExecutor(config = makeConfig()): { executor: FakeExecutor; captured: Captured } {
  const captured: Captured = {
    phases: [],
    logs: [],
    progress: [],
    completed: [],
    failed: [],
    cancelled: [],
  };
  const executor = new FakeExecutor(config, {
    onPhase: (session, phase, message) => {
      captured.phases.push({ executionId: session.executionId, phase, message });
    },
    onLog: (session, entry) => {
      captured.logs.push({ executionId: session.executionId, entry });
    },
    onProgress: (session, progress, step) => {
      captured.progress.push({ executionId: session.executionId, progress, step });
    },
    onCompleted: (session, payload) => {
      captured.completed.push({ executionId: session.executionId, payload });
    },
    onFailed: (session, payload) => {
      captured.failed.push({ executionId: session.executionId, payload });
    },
    onCancelled: (session, payload) => {
      captured.cancelled.push({ executionId: session.executionId, payload });
    },
  });
  return { executor, captured };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('FakeExecutor', () => {
  it('emits phases, logs, progress and a completed result without a real model', async () => {
    const { executor, captured } = createExecutor();
    executor.start(startPayload());

    await waitFor(() => captured.completed.length === 1);

    expect(captured.completed[0]?.payload).toMatchObject({
      exitCode: 0,
      summary: expect.stringContaining('Fake runner completed'),
    });
    const git = captured.completed[0]?.payload.git as GitExecutionResult;
    expect(git.branchName).toBe('haft/execution_runner_test');
    expect(git.changedFiles).toBe(2);
    expect(git.diffTruncated).toBe(false);
    expect(git.diff).toContain('diff --git a/packages/example/src/feature.ts');
    expect(git.diff).toContain('+++ b/packages/example/test/feature.spec.ts');

    expect(captured.phases.map((phase) => phase.phase)).toEqual([
      'preparing',
      'running',
      'finalizing',
    ]);
    expect(captured.logs[0]?.entry.message).toContain('Fake runner accepted');
    expect(captured.logs.every((log) => log.entry.sequence > 0)).toBe(true);
    expect(captured.progress.at(-1)).toMatchObject({ progress: 100 });
    expect(executor.snapshot()).toEqual([]);
    expect(executor.activeExecutionIds()).toEqual([]);
  });

  it('keeps unacknowledged logs for replay and drops acknowledged ones', async () => {
    const { executor, captured } = createExecutor();
    executor.start(startPayload());
    await waitFor(() => captured.logs.length >= 2);

    const pending = executor.pendingLogs('execution_runner_test');
    expect(pending.length).toBeGreaterThanOrEqual(2);
    executor.acknowledge('execution_runner_test', 1);
    const remaining = executor.pendingLogs('execution_runner_test');
    expect(remaining.every((entry) => entry.sequence > 1)).toBe(true);
    expect(executor.pendingLogCount()).toBe(remaining.length);
    executor.cancel('execution_runner_test', 'cleanup');
    await waitFor(() => captured.cancelled.length === 1);
  });

  it('cancels the execution and never reports completion', async () => {
    const { executor, captured } = createExecutor(makeConfig({ stepMs: 100 }));
    executor.start(startPayload());
    await waitFor(() => captured.logs.length >= 1);
    executor.cancel('execution_runner_test', 'Stop requested');

    await waitFor(() => captured.cancelled.length === 1);
    expect(captured.cancelled[0]?.payload.reason).toBe('Stop requested');
    expect(captured.completed).toHaveLength(0);
    expect(executor.snapshot()).toEqual([]);
  });

  it('supports a deterministic failure path for tests', async () => {
    const { executor, captured } = createExecutor();
    executor.start(
      startPayload({
        taskTitle: 'Failure path [fail]',
      }),
    );

    await waitFor(() => captured.failed.length === 1);
    expect(captured.failed[0]?.payload).toMatchObject({
      reason: expect.stringContaining('FAKE_RUNNER_FAILURE'),
      exitCode: 2,
    });
    expect(captured.completed).toHaveLength(0);
  });

  it('reports active sessions in a snapshot while running', async () => {
    const { executor, captured } = createExecutor(makeConfig({ stepMs: 200 }));
    executor.start(startPayload());
    const snapshot = executor.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      executionId: 'execution_runner_test',
      runtime: 'codex',
      phase: 'preparing',
    });
    executor.cancel('execution_runner_test', 'cleanup');
    await waitFor(() => captured.cancelled.length === 1);
  });

  it('waits for each session to terminate during shutdown', async () => {
    const { executor, captured } = createExecutor(makeConfig({ stepMs: 1000 }));
    executor.start(startPayload());
    await waitFor(() => captured.logs.length >= 1);

    const startedAt = Date.now();
    const result = await executor.shutdown('Runner shutting down');
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({
      clean: true,
      remainingExecutionIds: [],
      forced: false,
    });
    expect(captured.cancelled).toHaveLength(1);
    expect(captured.cancelled[0]?.payload.reason).toContain('Runner shutting down');
    // Cancellation is acknowledged after the session's delay, not a fixed
    // fire-and-forget 150 ms sleep.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(executor.activeExecutionIds()).toEqual([]);
  });
});
