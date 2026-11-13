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
import type { TreeTerminationResult, TreeVerification } from '../src/process-guard';
import { RealExecutor } from '../src/real-executor';
import type { ExecutionRecovery } from '../src/recovery';
import type { RepositoryContext } from '../src/repository-context';
import type { RepositoryPathPolicy } from '../src/repository-policy';

const EXECUTION_ID = 'execution_finalize_race';

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
  kill: () => boolean;
}

interface FakeManaged {
  verifyTreeGone: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

interface InternalSession {
  managed: unknown;
  cancelled: boolean;
  timedOut: boolean;
  finished: boolean;
  treeConfirmedGone: boolean;
  finalizePromise: Promise<void> | null;
  finalizeRequests: unknown[];
  finalizeCommitted: boolean;
  journalAborted: boolean;
}

interface InternalExecutor {
  sessions: Map<string, InternalSession>;
  uncertainOrphans: Set<string>;
  finalize(
    session: InternalSession,
    outcome: 'completed' | 'failed' | 'cancelled',
    result: { reason?: string; exitCode?: number | null; summary?: string | null },
  ): Promise<void>;
  finishFromClose(
    session: InternalSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void>;
  handleTerminalFallback(session: InternalSession, outcome: 'cancelled' | 'timeout'): Promise<void>;
  abortSpawnedProcess(session: InternalSession, child: ChildProcess, reason: string): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    shutdownGraceMs: 30,
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

function startPayload(): ExecutionStartMessage['payload'] {
  return {
    executionId: EXECUTION_ID,
    runtime: 'codex',
    taskId: 'task_finalize_race',
    taskTitle: 'Finalize race',
    taskDescription: 'A deterministic task for terminal single-flight tests.',
    projectId: 'project_demo',
    prompt: 'Do the task.',
    options: {},
  };
}

function repositoryContext(): RepositoryContext {
  return {
    contextId: 'context_finalize_race',
    executionId: EXECUTION_ID,
    projectId: 'project_demo',
    bindingId: 'binding_finalize_race',
    bindingVersion: 1,
    policyVersion: 'policy-v1',
    configuredPath: '/virtual/repository',
    canonicalPath: '/virtual/repository',
    defaultBranch: 'main',
    baseCommit: 'a'.repeat(40),
    state: 'ready',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
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
  child.kill = () => true;
  return child;
}

function confirmedVerification(): TreeVerification {
  return {
    confirmed: true,
    reason: 'test tree is gone',
    identityMismatch: false,
    supervisor: null,
    cli: null,
    groupMemberCount: 0,
    cgroupMemberCount: 0,
  };
}

function confirmedTermination(): TreeTerminationResult {
  return {
    ...confirmedVerification(),
    requested: true,
    killIssued: true,
  };
}

function createHarness(finishImplementation?: () => Promise<void>): {
  executor: RealExecutor;
  internal: InternalExecutor;
  captured: Captured;
  child: FakeChild;
  journal: { finish: ReturnType<typeof vi.fn> };
  collect: ReturnType<typeof vi.fn>;
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
  const journal = {
    begin: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    finish: finishImplementation
      ? vi.fn(finishImplementation)
      : vi.fn().mockResolvedValue(undefined),
    flushAll: vi.fn().mockResolvedValue(undefined),
    setBackgroundErrorHandler: vi.fn(),
  };
  const recovery = {
    journal,
    spool: { flush: vi.fn() },
    isWorktreeBlocked: () => false,
  } as unknown as ExecutionRecovery;

  const collect = vi.fn(async () => null);
  const repositoryPolicy = {
    policyVersion: 'policy-v1',
    assertStillAllowed: vi.fn(async () => undefined),
  } as unknown as RepositoryPathPolicy;

  const executor = new RealExecutor(makeConfig(), callbacks, recovery, {
    resolveExecutable: async () => ({ path: '/virtual/codex', searched: [], error: null }),
    spawnProcess: () => {
      resolveSpawned();
      return child as unknown as ChildProcess;
    },
    inspectProcess: async (pid: number) => ({
      pid,
      parentPid: 1,
      processGroupId: pid,
      startTime: 'start-test',
      commandLine: 'codex exec',
    }),
    terminateProcess: vi.fn(async () => undefined),
    waitForProcessExit: async () => true,
    repositoryPolicy,
    git: {
      prepare: async () => ({
        path: '/virtual/worktree',
        branchName: `haft/${EXECUTION_ID}`,
        baseCommit: 'a'.repeat(40),
      }),
      collect,
      cleanup: async () => ({ path: '', removed: false }),
    },
    shutdownForceWaitMs: 100,
  });

  return {
    executor,
    internal: executor as unknown as InternalExecutor,
    captured,
    child,
    journal,
    collect,
    spawned,
  };
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

async function startSession(harness: ReturnType<typeof createHarness>): Promise<InternalSession> {
  harness.executor.start(startPayload(), repositoryContext());
  await harness.spawned;
  await waitFor(() => harness.captured.phases.some((entry) => entry.phase === 'running'));
  const session = harness.internal.sessions.get(EXECUTION_ID);
  if (!session) throw new Error('session was not created');
  return session;
}

function attachManaged(
  session: InternalSession,
  options: {
    verification?: Promise<TreeVerification>;
    termination?: TreeTerminationResult;
  } = {},
): FakeManaged {
  const verification =
    options.verification ??
    Promise.resolve(
      options.termination ?? {
        ...confirmedVerification(),
      },
    );
  const managed: FakeManaged = {
    verifyTreeGone: vi.fn(async () => await verification),
    terminate: vi.fn(async () => options.termination ?? confirmedTermination()),
  };
  session.managed = managed;
  return managed;
}

describe('RealExecutor finalize single-flight (F1-F9)', () => {
  it('F1: two concurrent finalize calls with the same outcome share one decision', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    const gate = deferred<TreeVerification>();
    const managed = attachManaged(session, { verification: gate.promise });

    const first = harness.internal.finalize(session, 'completed', { exitCode: 0 });
    const second = harness.internal.finalize(session, 'completed', { exitCode: 0 });
    expect(second).toBe(first);
    await waitFor(() => managed.verifyTreeGone.mock.calls.length === 1);

    gate.resolve(confirmedVerification());
    await Promise.all([first, second]);

    expect(managed.verifyTreeGone).toHaveBeenCalledTimes(1);
    expect(harness.collect).toHaveBeenCalledTimes(1);
    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.journal.finish).toHaveBeenCalledWith(
      EXECUTION_ID,
      'completed',
      'completed',
      expect.any(Number),
    );
    expect(harness.captured.completed).toHaveLength(1);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.cancelled).toHaveLength(0);
    expect(session.finished).toBe(true);
    expect(session.finalizeCommitted).toBe(true);
    expect(session.finalizePromise).toBeNull();
    expect(harness.internal.sessions.has(EXECUTION_ID)).toBe(false);
    expect(harness.internal.uncertainOrphans.has(EXECUTION_ID)).toBe(false);

    // A late caller after the committed decision is a no-op, not a second
    // terminal path.
    await harness.internal.finalize(session, 'failed', { reason: 'late failure' });
    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.captured.completed).toHaveLength(1);
    expect(harness.captured.failed).toHaveLength(0);
  });

  it('F2: a failure requested while finalization is in flight wins deterministically', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    const gate = deferred<TreeVerification>();
    attachManaged(session, { verification: gate.promise });

    const completed = harness.internal.finalize(session, 'completed', { exitCode: 0 });
    const failed = harness.internal.finalize(session, 'failed', {
      reason: 'injected concurrent failure',
      exitCode: null,
    });
    gate.resolve(confirmedVerification());
    await Promise.all([completed, failed]);

    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.journal.finish).toHaveBeenCalledWith(
      EXECUTION_ID,
      'failed',
      'failed',
      expect.any(Number),
    );
    expect(harness.captured.completed).toHaveLength(0);
    expect(harness.captured.failed).toHaveLength(1);
    expect(harness.captured.failed[0]?.payload.reason).toContain('injected concurrent failure');
    expect(session.finished).toBe(true);
  });

  it('F3: close and the 15s fallback race produce one cancelled terminal decision', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    session.cancelled = true;
    const gate = deferred<TreeVerification>();
    const managed = attachManaged(session, { verification: gate.promise });

    const close = harness.internal.finishFromClose(session, null, 'SIGTERM');
    const fallback = harness.internal.handleTerminalFallback(session, 'cancelled');
    gate.resolve({
      ...confirmedVerification(),
      reason: 'close-path tree confirmation',
    });
    await Promise.all([close, fallback]);

    expect(managed.terminate).toHaveBeenCalled();
    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.journal.finish.mock.calls[0]?.[1]).toBe('cancelled');
    expect(harness.captured.cancelled).toHaveLength(1);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.completed).toHaveLength(0);
    expect(session.finished).toBe(true);
  });

  it('F4: close and abortSpawnedProcess race produce one failed decision', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    const gate = deferred<TreeVerification>();
    attachManaged(session, { verification: gate.promise });

    const close = harness.internal.finishFromClose(session, 0, null);
    const abort = harness.internal.abortSpawnedProcess(
      session,
      harness.child as unknown as ChildProcess,
      'injected post-spawn abort',
    );
    gate.resolve(confirmedVerification());
    await Promise.all([close, abort]);

    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.journal.finish.mock.calls[0]?.[1]).toBe('failed');
    expect(harness.captured.failed).toHaveLength(1);
    expect(harness.captured.failed[0]?.payload.reason).toContain('injected post-spawn abort');
    expect(harness.captured.completed).toHaveLength(0);
    expect(session.finished).toBe(true);
  });

  it('F5: a delayed tree confirmation does not admit a second finalize flow', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    const gate = deferred<TreeVerification>();
    const managed = attachManaged(session, { verification: gate.promise });

    const first = harness.internal.finalize(session, 'completed', { exitCode: 0 });
    await waitFor(() => managed.verifyTreeGone.mock.calls.length === 1);
    const second = harness.internal.finalize(session, 'completed', { exitCode: 0 });
    const third = harness.internal.finalize(session, 'failed', { reason: 'late failure' });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(managed.verifyTreeGone).toHaveBeenCalledTimes(1);

    gate.resolve(confirmedVerification());
    await Promise.all([first, second, third]);

    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.captured.failed).toHaveLength(1);
    expect(harness.captured.completed).toHaveLength(0);
  });

  it('F6: a journal finish failure sends no terminal event and keeps the execution uncertain', async () => {
    const harness = createHarness(async () => {
      throw new Error('injected finish journal failure');
    });
    const session = await startSession(harness);
    const gate = deferred<TreeVerification>();
    attachManaged(session, { verification: gate.promise });

    const first = harness.internal.finalize(session, 'completed', { exitCode: 0 });
    const second = harness.internal.finalize(session, 'completed', { exitCode: 0 });
    gate.resolve(confirmedVerification());
    await Promise.all([first, second]);

    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.captured.completed).toHaveLength(0);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.cancelled).toHaveLength(0);
    expect(session.finished).toBe(true);
    expect(harness.internal.sessions.has(EXECUTION_ID)).toBe(true);
    expect(harness.internal.uncertainOrphans.has(EXECUTION_ID)).toBe(true);
    expect(harness.executor.snapshot().map((entry) => entry.executionId)).toContain(EXECUTION_ID);
  });

  it('F7: a journal success sends exactly one terminal event', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    const gate = deferred<TreeVerification>();
    attachManaged(session, { verification: gate.promise });

    const calls = [
      harness.internal.finalize(session, 'completed', { exitCode: 0 }),
      harness.internal.finalize(session, 'completed', { exitCode: 0 }),
      harness.internal.finalize(session, 'completed', { exitCode: 0 }),
    ];
    gate.resolve(confirmedVerification());
    await Promise.all(calls);

    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.captured.completed).toHaveLength(1);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.cancelled).toHaveLength(0);
  });

  it('F8: different outcomes keep the journal and the terminal event consistent', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    const gate = deferred<TreeVerification>();
    attachManaged(session, { verification: gate.promise });

    const cancelled = harness.internal.finalize(session, 'cancelled', {
      reason: 'operator cancelled',
      exitCode: null,
    });
    const failed = harness.internal.finalize(session, 'failed', {
      reason: 'exit code 1',
      exitCode: 1,
    });
    gate.resolve(confirmedVerification());
    await Promise.all([cancelled, failed]);

    expect(harness.journal.finish).toHaveBeenCalledTimes(1);
    expect(harness.journal.finish.mock.calls[0]?.[1]).toBe('failed');
    expect(harness.captured.failed).toHaveLength(1);
    expect(harness.captured.cancelled).toHaveLength(0);
    expect(harness.captured.completed).toHaveLength(0);
    expect(harness.captured.failed[0]?.payload.reason).toContain('exit code 1');
  });

  it('F9: an unconfirmed process tree never finalizes the journal or emits an event', async () => {
    const harness = createHarness();
    const session = await startSession(harness);
    const managed = attachManaged(session, {
      verification: Promise.resolve({
        ...confirmedVerification(),
        confirmed: false,
        reason: 'injected descendant is still alive',
      }),
    });

    await harness.internal.finalize(session, 'completed', { exitCode: 0 });

    expect(managed.verifyTreeGone).toHaveBeenCalledTimes(1);
    expect(harness.journal.finish).not.toHaveBeenCalled();
    expect(harness.captured.completed).toHaveLength(0);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.cancelled).toHaveLength(0);
    expect(session.finished).toBe(true);
    expect(session.treeConfirmedGone).toBe(false);
    expect(session.finalizeCommitted).toBe(false);
    expect(session.finalizePromise).toBeNull();
    expect(harness.internal.sessions.has(EXECUTION_ID)).toBe(true);
    expect(harness.internal.uncertainOrphans.has(EXECUTION_ID)).toBe(true);
    expect(
      harness.captured.logs.some((entry) =>
        entry.entry.message.includes('PROCESS_TREE_NOT_CONFIRMED'),
      ),
    ).toBe(true);

    // Uncertainty is terminal for this in-process session: a later request
    // must not turn it into a success behind the active journal.
    await harness.internal.finalize(session, 'completed', { exitCode: 0 });
    expect(harness.journal.finish).not.toHaveBeenCalled();
    expect(harness.captured.completed).toHaveLength(0);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.cancelled).toHaveLength(0);
  });
});
