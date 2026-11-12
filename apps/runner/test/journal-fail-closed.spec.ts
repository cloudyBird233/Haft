import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionPhase, ExecutionStartMessage, RunnerLogEntry } from '@raft-lite/contracts';
import type { RunnerConfig } from '../src/config';
import {
  ExecutionJournal,
  type ExecutionJournalPatch,
  type ExecutionJournalRecord,
} from '../src/execution-journal';
import type {
  CancelledPayload,
  CompletedPayload,
  ExecutorCallbacks,
  FailedPayload,
} from '../src/executor';
import { RealExecutor } from '../src/real-executor';
import { ExecutionRecovery, type RecoveryDependencies } from '../src/recovery';
import type { RepositoryContext } from '../src/repository-context';
import type { RepositoryPathPolicy } from '../src/repository-policy';

const EXECUTION_ID = 'execution_journal_fail_closed';
const roots: string[] = [];

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

interface Captured {
  phases: Array<{ executionId: string; phase: ExecutionPhase }>;
  logs: Array<{ executionId: string; entry: RunnerLogEntry }>;
  completed: Array<{ executionId: string; payload: CompletedPayload }>;
  failed: Array<{ executionId: string; payload: FailedPayload }>;
  cancelled: Array<{ executionId: string; payload: CancelledPayload }>;
}

interface FakeJournal {
  begin: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  flushAll: ReturnType<typeof vi.fn>;
  setBackgroundErrorHandler: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  journal?: FakeJournal | ExecutionJournal;
  config?: Partial<RunnerConfig>;
  waitForProcessExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  onSpawn?: () => void;
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
    executionId: EXECUTION_ID,
    runtime: 'codex',
    taskId: 'task_journal',
    taskTitle: 'Journal fault injection',
    taskDescription: 'A deterministic task for journal fail-closed tests.',
    projectId: 'project_demo',
    prompt: 'Do the task.',
    options: {},
    ...overrides,
  };
}

function repositoryContext(): RepositoryContext {
  return {
    contextId: 'context_journal',
    executionId: EXECUTION_ID,
    projectId: 'project_demo',
    bindingId: 'binding_journal',
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

function fakeJournal(overrides: Partial<FakeJournal> = {}): FakeJournal {
  return {
    begin: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    flushAll: vi.fn().mockResolvedValue(undefined),
    setBackgroundErrorHandler: vi.fn(),
    ...overrides,
  };
}

function createHarness(options: HarnessOptions = {}): {
  executor: RealExecutor;
  captured: Captured;
  child: FakeChild;
  journal: FakeJournal | ExecutionJournal;
  spawn: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  waitForProcessExit: ReturnType<typeof vi.fn>;
  gitPrepare: ReturnType<typeof vi.fn>;
  spawned: Promise<void>;
} {
  const journal = options.journal ?? fakeJournal();
  const recovery = {
    journal,
    spool: { flush: vi.fn() },
    isWorktreeBlocked: () => false,
  } as unknown as ExecutionRecovery;

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
  const spawn = vi.fn(() => {
    options.onSpawn?.();
    resolveSpawned();
    return child as unknown as ChildProcess;
  });
  const terminate = vi.fn(async () => undefined);
  const waitForProcessExit = vi.fn(options.waitForProcessExit ?? (async () => true));
  const gitPrepare = vi.fn(async () => ({
    path: '/virtual/worktree',
    branchName: `haft/${EXECUTION_ID}`,
    baseCommit: 'a'.repeat(40),
  }));

  const repositoryPolicy = {
    policyVersion: 'policy-v1',
    assertStillAllowed: vi.fn(async () => undefined),
  } as unknown as RepositoryPathPolicy;

  const executor = new RealExecutor(makeConfig(options.config), callbacks, recovery, {
    resolveExecutable: async () => ({ path: '/virtual/codex', searched: [], error: null }),
    spawnProcess: spawn,
    inspectProcess: async (pid: number) => ({
      pid,
      parentPid: 1,
      processGroupId: pid,
      startTime: 'start-test',
      commandLine: 'codex exec',
    }),
    terminateProcess: terminate,
    waitForProcessExit,
    repositoryPolicy,
    git: {
      prepare: gitPrepare,
      collect: async () => null,
      cleanup: async () => ({ path: '', removed: false }),
    },
    shutdownForceWaitMs: 100,
  });

  return {
    executor,
    captured,
    child,
    journal,
    spawn,
    terminate,
    waitForProcessExit,
    gitPrepare,
    spawned,
  };
}

function journalRecord(overrides: Partial<ExecutionJournalRecord> = {}): ExecutionJournalRecord {
  return {
    version: 1,
    executionId: EXECUTION_ID,
    runtime: 'codex',
    projectId: 'project_demo',
    pid: 4242,
    processStartTime: 'start-100',
    processGroupId: 4242,
    worktreePath: '/tmp/worktrees/project/execution_journal_fail_closed',
    branchName: `haft/${EXECUTION_ID}`,
    baseCommit: 'a'.repeat(40),
    phase: 'running',
    status: 'active',
    lastSequence: 3,
    startedAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:00:01.000Z',
    finishedAt: null,
    ...overrides,
  };
}

function recoveryDependencies(overrides: Partial<RecoveryDependencies> = {}): RecoveryDependencies {
  return {
    inspectProcess: vi.fn().mockResolvedValue(null),
    terminateProcessTree: vi.fn().mockResolvedValue(undefined),
    waitForProcessExit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-journal-fail-closed-'));
  roots.push(root);
  return root;
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

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Recovery journal fail-closed (J1-J10)', () => {
  it('J1: beginJournal write failure never spawns the CLI', async () => {
    const journal = fakeJournal({
      begin: vi.fn().mockRejectedValue(new Error('journal disk full')),
    });
    const harness = createHarness({ journal });

    harness.executor.start(startPayload(), repositoryContext());
    await waitFor(() => harness.captured.failed.length === 1);

    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.gitPrepare).not.toHaveBeenCalled();
    expect(harness.captured.failed[0]?.payload.reason).toContain('RECOVERY_JOURNAL_WRITE_FAILED');
    expect(harness.captured.failed[0]?.payload.reason).toContain('journal disk full');
    expect(journal.finish).not.toHaveBeenCalled();
    expect(harness.executor.activeExecutionIds()).toEqual([]);
  });

  it('J2: atomic journal write failure never continues to the worktree or spawn', async () => {
    const root = await makeRoot();
    const journal = new ExecutionJournal(root, {
      atomicWrite: vi.fn().mockRejectedValue(new Error('atomic rename failed')),
    });
    const harness = createHarness({ journal });

    harness.executor.start(startPayload(), repositoryContext());
    await waitFor(() => harness.captured.failed.length === 1);

    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.gitPrepare).not.toHaveBeenCalled();
    expect(harness.captured.failed[0]?.payload.reason).toContain('atomic rename failed');
    expect(await readdir(root)).toEqual([]);
    expect(harness.executor.activeExecutionIds()).toEqual([]);
  });

  it('J3: PID persistence failure terminates the spawned process tree and confirms exit', async () => {
    const journal = fakeJournal({
      update: vi.fn(async (_executionId: string, patch: ExecutionJournalPatch) => {
        if (patch.pid !== undefined) throw new Error('pid journal write failed');
      }),
    });
    const harness = createHarness({ journal });

    harness.executor.start(startPayload(), repositoryContext());
    await harness.spawned;
    await waitFor(() => harness.captured.failed.length === 1);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.terminate).toHaveBeenCalledWith(harness.child, true);
    expect(harness.waitForProcessExit).toHaveBeenCalledWith(4321, expect.any(Number));
    expect(harness.captured.failed[0]?.payload.reason).toContain(
      'RECOVERY_JOURNAL_PID_WRITE_FAILED',
    );
    expect(harness.captured.failed[0]?.payload.reason).toContain('exit was confirmed');
    expect(harness.captured.completed).toHaveLength(0);
    expect(journal.finish).toHaveBeenCalledWith(
      EXECUTION_ID,
      'failed',
      'failed',
      expect.any(Number),
    );
  });

  it('J3b: a fast exit during PID persistence does not bypass the journal failure', async () => {
    const holder: { harness?: ReturnType<typeof createHarness> } = {};
    const journal = fakeJournal({
      update: vi.fn(async (_executionId: string, patch: ExecutionJournalPatch) => {
        if (patch.pid !== undefined) {
          // The CLI exits while the PID write is in flight.
          holder.harness?.child.close(0, null);
          throw new Error('pid journal write failed');
        }
      }),
    });
    const harness = createHarness({ journal });
    holder.harness = harness;

    harness.executor.start(startPayload(), repositoryContext());
    await harness.spawned;
    await waitFor(() => harness.captured.failed.length === 1);

    expect(harness.captured.completed).toHaveLength(0);
    expect(harness.captured.failed[0]?.payload.reason).toContain(
      'RECOVERY_JOURNAL_PID_WRITE_FAILED',
    );
    expect(harness.captured.failed[0]?.payload.reason).toContain('already exited');
  });

  it('J4: unconfirmed termination is reported as an uncertain orphan, not a success', async () => {
    const journal = fakeJournal({
      update: vi.fn(async (_executionId: string, patch: ExecutionJournalPatch) => {
        if (patch.pid !== undefined) throw new Error('pid journal write failed');
      }),
    });
    const harness = createHarness({
      journal,
      waitForProcessExit: async () => false,
    });

    harness.executor.start(startPayload(), repositoryContext());
    await harness.spawned;
    await waitFor(() => harness.waitForProcessExit.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.terminate).toHaveBeenCalledWith(harness.child, true);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.completed).toHaveLength(0);
    // The journal must stay active so the next startup scan retries.
    expect(journal.finish).not.toHaveBeenCalled();
    expect(harness.executor.activeExecutionIds()).toContain(EXECUTION_ID);

    const shutdown = await harness.executor.shutdown();
    expect(shutdown.clean).toBe(false);
    expect(shutdown.remainingExecutionIds).toContain(EXECUTION_ID);

    // A late close event must not produce a terminal event.
    harness.child.close(null, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.captured.failed).toHaveLength(0);
  });

  it('J5: a mid-run persistJournal failure is surfaced and aborts the execution', async () => {
    const journal = fakeJournal({
      update: vi.fn(async (_executionId: string, patch: ExecutionJournalPatch) => {
        if (patch.phase === 'running') throw new Error('mid-run journal write failed');
      }),
    });
    const harness = createHarness({ journal });

    harness.executor.start(startPayload(), repositoryContext());
    await harness.spawned;
    await waitFor(() => harness.captured.failed.length === 1);

    expect(harness.terminate).toHaveBeenCalledWith(harness.child, true);
    expect(harness.captured.failed[0]?.payload.reason).toContain('RECOVERY_JOURNAL_WRITE_FAILED');
    expect(harness.captured.failed[0]?.payload.reason).toContain('mid-run journal write failed');
    expect(harness.captured.completed).toHaveLength(0);
    expect(journal.finish).toHaveBeenCalledWith(
      EXECUTION_ID,
      'failed',
      'failed',
      expect.any(Number),
    );
  });

  it('J6: finishJournal write failure never reports a completed or reliable failed execution', async () => {
    const journal = fakeJournal({
      finish: vi.fn().mockRejectedValue(new Error('finish journal write failed')),
    });
    const harness = createHarness({ journal });

    harness.executor.start(startPayload(), repositoryContext());
    await harness.spawned;
    await harness.child.promptWritten;
    harness.child.close(0, null);
    const finishMock = journal.finish as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => finishMock.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.captured.completed).toHaveLength(0);
    expect(harness.captured.failed).toHaveLength(0);
    expect(journal.finish).toHaveBeenCalledTimes(1);
    // The execution stays active locally; the journal is the evidence.
    expect(harness.executor.activeExecutionIds()).toContain(EXECUTION_ID);
  });

  it('J7a: a restart with no journal directory returns an empty, clean scan', async () => {
    const root = join(await makeRoot(), 'missing-recovery-root');
    const deps = recoveryDependencies();
    const recovery = new ExecutionRecovery(root, deps);

    const scan = await recovery.scan();
    expect(scan.executions).toEqual([]);
    expect(scan.corrupted).toEqual([]);
    expect(scan.clean).toBe(true);
    expect(deps.inspectProcess).not.toHaveBeenCalled();
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
  });

  it('J7b: a journal without a PID blocks recovery and is never finalized', async () => {
    const root = await makeRoot();
    const deps = recoveryDependencies();
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(
      journalRecord({
        pid: null,
        processStartTime: null,
        processGroupId: null,
      }),
    );

    const report = (await recovery.scan()).executions[0];

    expect(deps.inspectProcess).not.toHaveBeenCalled();
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      processAlive: false,
      journalFinalized: false,
      recoveryBlocked: true,
      treeConfirmedGone: false,
    });
    expect(report?.summary).toContain('PID_NOT_RECORDED');
    expect((await recovery.journal.read(EXECUTION_ID))?.status).toBe('active');
  });

  it('J7c: a restart treats an unverifiable live PID as blocked and never kills it', async () => {
    const root = await makeRoot();
    const deps = recoveryDependencies({
      inspectProcess: vi.fn().mockResolvedValue({
        pid: 4242,
        parentPid: 1,
        processGroupId: 4242,
        startTime: 'start-100',
        commandLine: 'codex exec -C /tmp/worktrees/project/execution_journal_fail_closed -',
      }),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(journalRecord({ processStartTime: null }));

    const report = (await recovery.scan()).executions[0];

    expect(deps.inspectProcess).toHaveBeenCalledWith(4242);
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      processAlive: true,
      processIdentityUnverified: true,
      journalFinalized: false,
      recoveryBlocked: true,
    });
    expect(report?.summary).toContain('PID_IDENTITY_UNVERIFIED');
    expect((await recovery.journal.read(EXECUTION_ID))?.status).toBe('active');
  });

  it('J8: a corrupt journal blocks recovery and is quarantined as evidence', async () => {
    const root = await makeRoot();
    const deps = recoveryDependencies();
    await writeFile(join(root, 'broken.json'), '{not-json', 'utf8');
    const recovery = new ExecutionRecovery(root, deps);

    const scan = await recovery.scan();
    expect(scan.executions).toEqual([]);
    expect(scan.corrupted).toHaveLength(1);
    expect(scan.clean).toBe(false);
    expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
    expect(deps.inspectProcess).not.toHaveBeenCalled();
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    const files = await readdir(root);
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('J9: a reused PID is left untouched, blocks recovery and stays active', async () => {
    const root = await makeRoot();
    const deps = recoveryDependencies({
      inspectProcess: vi.fn().mockResolvedValue({
        pid: 4242,
        parentPid: 1,
        processGroupId: 4242,
        startTime: 'start-999',
        commandLine: 'codex exec -C /tmp/worktrees/project/execution_journal_fail_closed -',
      }),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(journalRecord());

    const report = (await recovery.scan()).executions[0];

    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      pidReused: true,
      orphanTerminated: false,
      journalFinalized: false,
      recoveryBlocked: true,
    });
    expect(report?.summary).toContain('different process');
    expect((await recovery.journal.read(EXECUTION_ID))?.status).toBe('active');
  });

  it('J10: normal start, run and exit leave a completed journal and one terminal event', async () => {
    const root = await makeRoot();
    const journalPath = join(root, `${EXECUTION_ID}.json`);
    let journalExistedAtSpawn = false;
    const journal = new ExecutionJournal(root);
    const harness = createHarness({
      journal,
      onSpawn: () => {
        journalExistedAtSpawn = existsSync(journalPath);
      },
    });

    harness.executor.start(startPayload(), repositoryContext());
    await harness.spawned;
    await harness.child.promptWritten;
    harness.child.close(0, null);
    await waitFor(() => harness.captured.completed.length === 1);

    expect(journalExistedAtSpawn).toBe(true);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.captured.completed).toHaveLength(1);
    expect(harness.captured.failed).toHaveLength(0);
    expect(harness.captured.cancelled).toHaveLength(0);
    expect(harness.executor.activeExecutionIds()).toEqual([]);

    const restored = await journal.read(EXECUTION_ID);
    expect(restored).toMatchObject({
      status: 'completed',
      phase: 'completed',
      pid: 4321,
      processStartTime: 'start-test',
      processGroupId: 4321,
    });
    expect(restored?.finishedAt).toBeTruthy();
  });
});
