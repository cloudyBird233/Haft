import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionPhase, ExecutionStartMessage, RunnerLogEntry } from '@raft-lite/contracts';
import type { RunnerConfig } from '../src/config';
import type {
  CancelledPayload,
  CompletedPayload,
  ExecutorCallbacks,
  FailedPayload,
} from '../src/executor';
import { RealExecutor } from '../src/real-executor';

interface Captured {
  phases: Array<{ executionId: string; phase: ExecutionPhase }>;
  logs: Array<{ executionId: string; entry: RunnerLogEntry }>;
  completed: Array<{ executionId: string; payload: CompletedPayload }>;
  failed: Array<{ executionId: string; payload: FailedPayload }>;
  cancelled: Array<{ executionId: string; payload: CancelledPayload }>;
}

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  promptWritten: Promise<void>;
  kill: () => boolean;
  close: (code?: number | null, signal?: NodeJS.Signals | null) => void;
}

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    serverUrl: 'http://127.0.0.1:3001',
    runnerId: 'runner_test',
    computerId: 'computer_local',
    bootstrapToken: 'test-bootstrap-token',
    tokenFile: 'runner-test-token.json',
    mode: 'real',
    fakeRuntimes: [],
    realRuntimes: ['codex'],
    cliPaths: {},
    cliModels: {},
    gitBinary: 'git',
    worktreeRoot: process.cwd(),
    keepWorktrees: true,
    recoveryRoot: process.cwd(),
    shutdownGraceMs: 60,
    cliTimeoutMs: 60_000,
    allowAutoApprove: false,
    projectPaths: { project_demo: process.cwd() },
    allowedRepositoryRoots: [],
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
    executionId: 'execution_real_shutdown',
    runtime: 'codex',
    taskId: 'task_real_shutdown',
    taskTitle: 'Exercise shutdown',
    taskDescription: 'A deterministic task for real executor lifecycle tests.',
    projectId: 'project_demo',
    prompt: 'Do the task.',
    options: {},
    ...overrides,
  };
}

function createFakeChild(pid = 4321): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.promptWritten = new Promise<void>((resolve) => {
    child.stdin.once('finish', () => resolve());
  });
  child.kill = () => true;
  child.close = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('close', code, signal);
  };
  return child;
}

function createExecutor(
  options: {
    config?: RunnerConfig;
    onTerminate?: (child: FakeChild, force: boolean) => void;
  } = {},
): {
  executor: RealExecutor;
  captured: Captured;
  child: FakeChild;
  terminate: ReturnType<typeof vi.fn>;
  spawned: Promise<void>;
} {
  const captured: Captured = {
    phases: [],
    logs: [],
    completed: [],
    failed: [],
    cancelled: [],
  };
  const callbacks: ExecutorCallbacks = {
    onPhase: (session, phase) => {
      captured.phases.push({ executionId: session.executionId, phase });
    },
    onLog: (session, entry) => {
      captured.logs.push({ executionId: session.executionId, entry });
    },
    onProgress: () => undefined,
    onCompleted: (session, payload) => {
      captured.completed.push({ executionId: session.executionId, payload });
    },
    onFailed: (session, payload) => {
      captured.failed.push({ executionId: session.executionId, payload });
    },
    onCancelled: (session, payload) => {
      captured.cancelled.push({ executionId: session.executionId, payload });
    },
  };

  const child = createFakeChild();
  let resolveSpawned: () => void = () => undefined;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawned = resolve;
  });
  const terminate = vi.fn(async (spawnedChild: ChildProcess, force = false) => {
    options.onTerminate?.(spawnedChild as unknown as FakeChild, force);
  });

  const executor = new RealExecutor(options.config ?? makeConfig(), callbacks, undefined, {
    resolveExecutable: async () => ({ path: '/virtual/codex', searched: [], error: null }),
    spawnProcess: () => {
      resolveSpawned();
      return child as unknown as ChildProcess;
    },
    inspectProcess: async () => ({
      pid: child.pid,
      parentPid: 1,
      processGroupId: child.pid,
      startTime: 'start-test',
      commandLine: 'codex exec',
    }),
    terminateProcess: terminate,
    git: {
      prepare: async () => ({
        path: '/virtual/worktree',
        branchName: 'haft/execution_real_shutdown',
        baseCommit: 'a'.repeat(40),
      }),
      collect: async () => null,
      cleanup: async () => ({ path: '', removed: false }),
    },
    shutdownForceWaitMs: 100,
  });

  return { executor, captured, child, terminate, spawned };
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

describe('RealExecutor shutdown', () => {
  it('waits for the real child close event before reporting a clean shutdown', async () => {
    const { executor, captured, child, spawned } = createExecutor({
      config: makeConfig({ shutdownGraceMs: 500 }),
      onTerminate: (terminatedChild, force) => {
        if (!force) {
          setTimeout(() => terminatedChild.close(null, 'SIGTERM'), 30);
        }
      },
    });
    executor.start(startPayload());
    await spawned;
    await child.promptWritten;
    await waitFor(() => captured.phases.some((entry) => entry.phase === 'running'));

    const startedAt = Date.now();
    const result = await executor.shutdown('Runner shutting down');
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({
      clean: true,
      remainingExecutionIds: [],
      forced: false,
    });
    // The result must follow the child's close event, not a fixed delay.
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(captured.cancelled).toHaveLength(1);
    expect(captured.cancelled[0]?.payload.reason).toContain('Runner shutting down');
    expect(executor.activeExecutionIds()).toEqual([]);
  });

  it('escalates to a forced kill after the grace window and reports it', async () => {
    const { executor, captured, child, terminate, spawned } = createExecutor({
      onTerminate: (terminatedChild, force) => {
        if (force) {
          setTimeout(() => terminatedChild.close(null, 'SIGKILL'), 10);
        }
      },
    });
    executor.start(startPayload());
    await spawned;
    await child.promptWritten;
    await waitFor(() => captured.phases.some((entry) => entry.phase === 'running'));

    const result = await executor.shutdown('Runner shutting down');

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate.mock.calls[0]?.[1]).toBe(false);
    expect(terminate.mock.calls[1]?.[1]).toBe(true);
    expect(result).toEqual({
      clean: true,
      remainingExecutionIds: [],
      forced: true,
    });
    expect(captured.cancelled).toHaveLength(1);
  });

  it('reports incomplete cleanup when the child never confirms termination', async () => {
    const { executor, captured, child, spawned } = createExecutor();
    executor.start(startPayload());
    await spawned;
    await child.promptWritten;
    await waitFor(() => captured.phases.some((entry) => entry.phase === 'running'));

    const result = await executor.shutdown('Runner shutting down');

    expect(result.clean).toBe(false);
    expect(result.forced).toBe(true);
    expect(result.remainingExecutionIds).toEqual(['execution_real_shutdown']);
    expect(captured.cancelled).toHaveLength(0);

    // Release the session so the test does not leave process timers behind.
    child.close(null, 'SIGKILL');
    await waitFor(() => captured.cancelled.length === 1);
  });
});
