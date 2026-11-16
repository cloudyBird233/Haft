import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionPhase,
  ExecutionStartMessage,
  RunnerLogEntry,
} from '@raft-lite/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '../src/config';
import type {
  CancelledPayload,
  CompletedPayload,
  ExecutorCallbacks,
  FailedPayload,
} from '../src/executor';
import {
  readProcessGuard,
  sameStartTime,
  type ProcessGuardRecord,
  type TreeTerminationResult,
  type TreeVerification,
} from '../src/process-guard';
import { inspectProcess, isProcessAlive, waitForProcessExit } from '../src/process-identity';
import { RealExecutor } from '../src/real-executor';
import type { ExecutionJournalRecord } from '../src/execution-journal';
import { ExecutionRecovery, type RecoveryDependencies } from '../src/recovery';
import type { RepositoryContext } from '../src/repository-context';
import type { RepositoryPathPolicy } from '../src/repository-policy';
import type { SupervisedProcess } from '../src/supervised-process';

/**
 * P2-4: real managed/supervised process tree evidence for the 15 s terminal
 * fallback.
 *
 * These tests never fake the process tree. `RealExecutor` runs its production
 * `managed` path, so a real supervisor (Windows Job Object / POSIX supervisor
 * script) owns a real CLI child and a real grandchild. Only time is injected
 * (`terminalFallbackMs`) so the fallback can be exercised without a 15 s wait,
 * which the WP-D Slice 1 task explicitly allows.
 *
 * The two frozen invariants under test:
 *   1. While any process of the protected tree is still alive, no terminal
 *      journal record and no terminal protocol event may exist.
 *   2. Once the whole tree is confirmed gone, exactly one terminal decision is
 *      written and its payload matches the journal.
 */

const cliFixture = join(__dirname, 'fixtures', 'real-cli.cjs');

interface CliMarker {
  marker: string;
  pid: number;
  ppid: number;
  guardPath: string | null;
  guardPresent: boolean | null;
  grandchildPid: number | null;
  startedAt: string;
}

interface Captured {
  phases: Array<{ executionId: string; phase: ExecutionPhase }>;
  logs: Array<{ executionId: string; entry: RunnerLogEntry }>;
  completed: Array<{ executionId: string; payload: CompletedPayload }>;
  failed: Array<{ executionId: string; payload: FailedPayload }>;
  cancelled: Array<{ executionId: string; payload: CancelledPayload }>;
}

interface SessionView {
  managed: SupervisedProcess | null;
  child: unknown;
  finished: boolean;
  treeConfirmedGone: boolean;
}

interface InternalExecutor {
  sessions: Map<string, SessionView>;
  uncertainOrphans: Set<string>;
}

const roots: string[] = [];
const trackedPids = new Set<number>();
const managedTrees: SupervisedProcess[] = [];

function unique(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-managed-fallback-'));
  roots.push(root);
  return root;
}

function makeConfig(root: string): RunnerConfig {
  return {
    serverUrl: 'http://127.0.0.1:3001',
    runnerId: 'runner_managed_fallback',
    computerId: 'computer_local',
    bootstrapToken: 'test-bootstrap-token',
    tokenFile: 'runner-managed-fallback-token.json',
    mode: 'real',
    fakeRuntimes: [],
    realRuntimes: ['codex'],
    cliPaths: {},
    cliModels: {},
    gitBinary: 'git',
    worktreeRoot: join(root, 'worktrees'),
    keepWorktrees: true,
    recoveryRoot: root,
    shutdownGraceMs: 100,
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
  };
}

function startPayload(executionId: string): ExecutionStartMessage['payload'] {
  return {
    executionId,
    runtime: 'codex',
    taskId: unique('task'),
    taskTitle: 'Managed terminal fallback',
    taskDescription: 'Exercises the real protected process tree.',
    projectId: 'project_demo',
    prompt: 'Do the task.',
    options: {},
  };
}

function repositoryContext(executionId: string, path: string): RepositoryContext {
  return {
    contextId: unique('context'),
    executionId,
    projectId: 'project_demo',
    bindingId: unique('binding'),
    bindingVersion: 1,
    policyVersion: 'policy-v1',
    configuredPath: path,
    canonicalPath: path,
    defaultBranch: 'main',
    baseCommit: 'a'.repeat(40),
    state: 'ready',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

function capturedCallbacks(): { captured: Captured; callbacks: ExecutorCallbacks } {
  const captured: Captured = {
    phases: [],
    logs: [],
    completed: [],
    failed: [],
    cancelled: [],
  };
  return {
    captured,
    callbacks: {
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
    },
  };
}

function fakeRepositoryPolicy(): RepositoryPathPolicy {
  return {
    policyVersion: 'policy-v1',
    assertStillAllowed: async () => undefined,
  } as unknown as RepositoryPathPolicy;
}

function recoveryDependencies(): RecoveryDependencies {
  return {
    inspectProcess,
    terminateProcessTree: async () => undefined,
    waitForProcessExit,
    readGuard: readProcessGuard,
  };
}

function terminalEventCount(captured: Captured): number {
  return captured.completed.length + captured.failed.length + captured.cancelled.length;
}

async function waitForJson<T>(path: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${path}: ${String(lastError)}`);
}

async function waitForCliMarker(
  path: string,
  requireGrandchild: boolean,
  timeoutMs = 30_000,
): Promise<CliMarker> {
  const deadline = Date.now() + timeoutMs;
  let marker = await waitForJson<CliMarker>(path, timeoutMs);
  if (!requireGrandchild) return marker;
  while (Date.now() < deadline) {
    if (marker.grandchildPid) return marker;
    await delay(20);
    marker = await waitForJson<CliMarker>(path, 2_000);
  }
  throw new Error(`CLI fixture never reported a grandchild PID: ${path}`);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function forceKill(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, or the platform refused a signal it does not implement.
  }
}

interface TrackedProcess {
  role: string;
  pid: number;
  /** Start marker captured while the process was definitely alive. */
  startTime: string | null;
}

/**
 * Captures a PID together with its OS start marker. A bare PID is not a safe
 * identity on a busy host: the number can be reused by an unrelated process
 * while this test is still running, which would turn a correct finalize into a
 * false failure.
 */
async function trackProcess(role: string, pid: number): Promise<TrackedProcess> {
  const identity = await inspectProcess(pid);
  return { role, pid, startTime: identity?.startTime ?? null };
}

/** True only while the PID still belongs to the process this test started. */
async function sameProcessAlive(entry: TrackedProcess): Promise<boolean> {
  const identity = await inspectProcess(entry.pid);
  if (!identity) return false;
  if (entry.startTime && identity.startTime) {
    return sameStartTime(entry.startTime, identity.startTime);
  }
  return isProcessAlive(entry.pid);
}

async function assertProcessGone(entry: TrackedProcess, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await sameProcessAlive(entry))) return;
    await delay(50);
  }
  throw new Error(`${entry.role} (PID ${entry.pid}) is still the process this execution started`);
}

function unconfirmed(reason: string): TreeTerminationResult {
  return {
    requested: true,
    confirmed: false,
    killIssued: true,
    identityMismatch: false,
    reason,
    supervisor: null,
    cli: null,
    groupMemberCount: 1,
    cgroupMemberCount: 0,
  };
}

function unconfirmedVerification(reason: string): TreeVerification {
  return {
    confirmed: false,
    reason,
    identityMismatch: false,
    supervisor: null,
    cli: null,
    groupMemberCount: 1,
    cgroupMemberCount: 0,
  };
}

afterEach(async () => {
  for (const managed of managedTrees.splice(0)) {
    await managed.terminate(true, 2_000).catch(() => undefined);
  }
  for (const pid of trackedPids) {
    await forceKill(pid);
  }
  trackedPids.clear();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 60_000);

describe('P2-4 managed process tree and the 15s terminal fallback', () => {
  it(
    'P2-4a: the fallback finalizes only after the whole real supervised tree is confirmed gone',
    async () => {
      const root = await makeRoot();
      const worktreePath = join(root, 'worktree');
      await mkdir(worktreePath, { recursive: true });
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts, { recursive: true });

      const executionId = unique('execution');
      const marker = unique('marker');
      const cliOut = join(artifacts, `cli-${marker}.json`);
      const journalPath = join(root, `${executionId}.json`);

      const recovery = new ExecutionRecovery(root, recoveryDependencies());
      const { captured, callbacks } = capturedCallbacks();

      // Exact evidence for invariant 1: captured synchronously inside the
      // terminal journal write, not sampled.
      const treePids = new Set<number>();
      let pidsAliveAtFinish: number[] = [];
      const originalFinish = recovery.journal.finish.bind(recovery.journal);
      vi.spyOn(recovery.journal, 'finish').mockImplementation(async (...args) => {
        pidsAliveAtFinish = [...treePids].filter((pid) => isProcessAlive(pid));
        return originalFinish(...args);
      });

      const executor = new RealExecutor(makeConfig(root), callbacks, recovery, {
        resolveExecutable: async () => ({ path: process.execPath, searched: [], error: null }),
        probeAuthentication: async () => ({ authenticated: true, message: null }),
        buildArgs: () => [cliFixture, marker, cliOut, '1', 'none'],
        repositoryPolicy: fakeRepositoryPolicy(),
        git: {
          prepare: async () => ({
            path: worktreePath,
            branchName: `haft/${executionId}`,
            baseCommit: 'a'.repeat(40),
          }),
          collect: async () => null,
          cleanup: async () => ({ path: worktreePath, removed: false }),
        },
        // Injected time only: the production fallback is 15 s.
        terminalFallbackMs: 40,
        shutdownForceWaitMs: 2_000,
      });
      const internal = executor as unknown as InternalExecutor;

      const payload = startPayload(executionId);
      const context = repositoryContext(executionId, worktreePath);
      expect(await executor.canAdmit(payload, context)).toEqual({ ok: true });
      executor.start(payload, context);

      const cli = await waitForCliMarker(cliOut, true);
      trackedPids.add(cli.pid);
      if (cli.grandchildPid) trackedPids.add(cli.grandchildPid);

      await waitFor(
        () => internal.sessions.get(executionId)?.managed != null,
        30_000,
        'managed supervisor',
      );

      const session = internal.sessions.get(executionId);
      expect(session).toBeDefined();
      const managed = session?.managed;
      expect(managed, 'the production managed path must own a real supervisor').toBeTruthy();
      if (!managed) return;
      managedTrees.push(managed);

      const guard = await managed.ready;
      trackedPids.add(guard.supervisorPid);
      const tree: TrackedProcess[] = [
        await trackProcess('supervisor', guard.supervisorPid),
        await trackProcess('cli', guard.cliPid ?? cli.pid),
      ];
      if (cli.grandchildPid) {
        tree.push(await trackProcess('descendant', cli.grandchildPid));
      }
      for (const entry of tree) treePids.add(entry.pid);

      // A descendant that must not be trivially gone: POSIX can really suspend
      // it. Windows has no portable suspend and the Job Object kills suspended
      // members anyway, so there the tree is simply left running.
      let descendantState: 'suspended' | 'running' = 'running';
      if (process.platform !== 'win32' && cli.grandchildPid) {
        process.kill(cli.grandchildPid, 'SIGSTOP');
        descendantState = 'suspended';
        expect(isProcessAlive(cli.grandchildPid)).toBe(true);
      }

      // Record which termination requests the executor makes, so the 15 s
      // fallback (the only force request during a cancel) is provably exercised.
      const terminationRequests: boolean[] = [];
      const realTerminate = managed.terminate.bind(managed);
      managed.terminate = async (force: boolean, timeoutMs?: number) => {
        terminationRequests.push(force);
        return realTerminate(force, timeoutMs);
      };

      // Sampled evidence for invariant 1: no terminal event may ever be
      // observed while a tracked PID of this execution is still alive. Sampling
      // stops at the first terminal event, so PID reuse after the decision can
      // never masquerade as a contradiction.
      const contradictoryObservations: Array<{ alive: number[]; events: number }> = [];
      let sampling = true;
      const sample = (): void => {
        if (!sampling) return;
        const events = terminalEventCount(captured);
        if (events > 0) {
          const alive = [...treePids].filter((pid) => isProcessAlive(pid));
          if (alive.length > 0) contradictoryObservations.push({ alive, events });
          sampling = false;
          return;
        }
        setTimeout(sample, 10);
      };
      setTimeout(sample, 10);

      try {
        executor.cancel(executionId, 'P2-4 operator cancel');
        try {
          await waitFor(
            () => terminalEventCount(captured) > 0,
            90_000,
            'terminal event after the fallback',
          );
        } catch (error) {
          console.log(
            'P2-4a DIAGNOSTIC logs:',
            JSON.stringify(captured.logs.map((entry) => entry.entry.message), null, 2),
          );
          console.log(
            'P2-4a DIAGNOSTIC alive:',
            JSON.stringify([...treePids].filter((pid) => isProcessAlive(pid))),
          );
          console.log('P2-4a DIAGNOSTIC requests:', JSON.stringify(terminationRequests));
          throw error;
        }
        // Let a late duplicate decision surface if the single-flight guard is broken.
        await delay(500);
      } finally {
        sampling = false;
      }

      expect(contradictoryObservations).toEqual([]);
      expect(captured.failed).toEqual([]);
      expect(captured.completed).toEqual([]);
      expect(captured.cancelled).toHaveLength(1);
      expect(captured.cancelled[0]?.payload.reason).toBe('P2-4 operator cancel');

      // Invariant 2: at the exact moment the terminal journal record was
      // written, no process of the protected tree was alive any more.
      expect(pidsAliveAtFinish).toEqual([]);
      expect(terminationRequests).toContain(true);

      const onDisk = JSON.parse(await readFile(journalPath, 'utf8')) as ExecutionJournalRecord;
      expect(onDisk.status).toBe('cancelled');
      expect(onDisk.phase).toBe('cancelled');
      expect(onDisk.finishedAt).not.toBeNull();
      expect(onDisk.processKind).toBe('supervisor');
      expect(onDisk.supervisorPid).toBe(guard.supervisorPid);

      const guardAfter = await readProcessGuard(managed.guardPath);
      expect(guardAfter.kind).toBe('ok');
      if (guardAfter.kind === 'ok') {
        const record: ProcessGuardRecord = guardAfter.guard;
        expect(['terminated', 'exited']).toContain(record.state);
        expect(record.treeConfirmedGone).toBe(true);
      }

      for (const entry of tree) {
        await assertProcessGone(entry);
      }
      expect(
        captured.logs.some((entry) =>
          entry.entry.message.includes('cancellation confirmed'),
        ),
      ).toBe(true);
      expect(executor.snapshot().map((entry) => entry.executionId)).not.toContain(executionId);

      // On POSIX the descendant really was suspended, so its death proves the
      // supervisor's verified force kill rather than an ordinary exit.
      if (descendantState === 'suspended' && cli.grandchildPid) {
        expect(isProcessAlive(cli.grandchildPid)).toBe(false);
      }
    },
    120_000,
  );

  it(
    'P2-4b: an unconfirmed tree never finalizes; the active journal stays authoritative',
    async () => {
      const root = await makeRoot();
      const worktreePath = join(root, 'worktree');
      await mkdir(worktreePath, { recursive: true });
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts, { recursive: true });

      const executionId = unique('execution');
      const marker = unique('marker');
      const cliOut = join(artifacts, `cli-${marker}.json`);
      const journalPath = join(root, `${executionId}.json`);

      const recovery = new ExecutionRecovery(root, recoveryDependencies());
      const { captured, callbacks } = capturedCallbacks();
      const finish = vi.spyOn(recovery.journal, 'finish');

      const executor = new RealExecutor(makeConfig(root), callbacks, recovery, {
        resolveExecutable: async () => ({ path: process.execPath, searched: [], error: null }),
        probeAuthentication: async () => ({ authenticated: true, message: null }),
        buildArgs: () => [cliFixture, marker, cliOut, '1', 'none'],
        repositoryPolicy: fakeRepositoryPolicy(),
        git: {
          prepare: async () => ({
            path: worktreePath,
            branchName: `haft/${executionId}`,
            baseCommit: 'a'.repeat(40),
          }),
          collect: async () => null,
          cleanup: async () => ({ path: worktreePath, removed: false }),
        },
        terminalFallbackMs: 40,
        shutdownForceWaitMs: 500,
      });
      const internal = executor as unknown as InternalExecutor;

      const payload = startPayload(executionId);
      const context = repositoryContext(executionId, worktreePath);
      expect(await executor.canAdmit(payload, context)).toEqual({ ok: true });
      executor.start(payload, context);

      const cli = await waitForCliMarker(cliOut, true);
      trackedPids.add(cli.pid);
      if (cli.grandchildPid) trackedPids.add(cli.grandchildPid);

      const session = internal.sessions.get(executionId);
      expect(session).toBeDefined();
      const managed = session?.managed;
      expect(managed, 'the production managed path must own a real supervisor').toBeTruthy();
      if (!managed) return;
      managedTrees.push(managed);
      const guard = await managed.ready;
      trackedPids.add(guard.supervisorPid);
      const tree: TrackedProcess[] = [
        await trackProcess('supervisor', guard.supervisorPid),
        await trackProcess('cli', guard.cliPid ?? cli.pid),
      ];
      if (cli.grandchildPid) {
        tree.push(await trackProcess('descendant', cli.grandchildPid));
      }

      // Fault injection at the OS-evidence boundary only. The tree stays real
      // and alive; what is injected is the supervisor's inability to prove it
      // gone (a real guard permission failure, a denied taskkill or an
      // unreadable cgroup produces exactly this result).
      const realTerminate = managed.terminate.bind(managed);
      managed.verifyTreeGone = async () =>
        unconfirmedVerification('injected: the protected tree could not be verified gone');
      managed.terminate = async () =>
        unconfirmed('injected: the OS refused to confirm the protected tree exit');

      executor.cancel(executionId, 'P2-4 unconfirmed cancel');

      await waitFor(
        () =>
          captured.logs.some((entry) =>
            entry.entry.message.includes('recovery journal was left active'),
          ),
        60_000,
        'fail-closed uncertainty latch',
      );
      await delay(300);

      // Nothing about the execution was decided: no journal finish, no event.
      expect(finish).not.toHaveBeenCalled();
      expect(captured.cancelled).toEqual([]);
      expect(captured.failed).toEqual([]);
      expect(captured.completed).toEqual([]);

      const onDisk = JSON.parse(await readFile(journalPath, 'utf8')) as ExecutionJournalRecord;
      expect(onDisk.status).toBe('active');
      expect(onDisk.finishedAt).toBeNull();
      expect(internal.uncertainOrphans.has(executionId)).toBe(true);
      expect(executor.snapshot().map((entry) => entry.executionId)).toContain(executionId);

      // The tree really was alive while the runner refused to guess.
      expect(isProcessAlive(cli.pid)).toBe(true);
      if (cli.grandchildPid) expect(isProcessAlive(cli.grandchildPid)).toBe(true);
      expect(
        captured.logs.some((entry) =>
          entry.entry.message.includes('could not be confirmed terminated'),
        ),
      ).toBe(true);

      // Shutdown must report the outstanding work instead of pretending the
      // runner is idle.
      const shutdown = await executor.shutdown('P2-4b shutdown');
      expect(shutdown.clean).toBe(false);
      expect(shutdown.remainingExecutionIds).toContain(executionId);
      expect(captured.cancelled).toEqual([]);
      expect(captured.failed).toEqual([]);

      // Now let the real supervisor kill the real tree, then prove that the
      // active journal carries enough evidence for recovery to resolve it.
      const termination = await realTerminate(true, 10_000);
      expect(termination.confirmed).toBe(true);
      for (const entry of tree) {
        await assertProcessGone(entry);
      }

      const scan = await new ExecutionRecovery(root, recoveryDependencies()).scan();
      expect(scan.blocked).toEqual([]);
      expect(scan.executions).toHaveLength(1);
      expect(scan.executions[0]?.journalFinalized).toBe(true);
      const recovered = JSON.parse(await readFile(journalPath, 'utf8')) as ExecutionJournalRecord;
      expect(recovered.status).toBe('interrupted');
    },
    120_000,
  );
});
