import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  ERROR_CODES,
  type ExecutionPhase,
  type ExecutionStartMessage,
  type RunnerEnvelope,
  type RunnerLogEntry,
} from '@raft-lite/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '../src/config';
import { ExecutionJournal, type ExecutionJournalRecord } from '../src/execution-journal';
import type {
  CancelledPayload,
  CompletedPayload,
  ExecutorCallbacks,
  FailedPayload,
} from '../src/executor';
import { startHealthServer } from '../src/health-server';
import {
  guardPathFor,
  readCgroupMembers,
  readProcessGuard,
  terminateGuardedTree,
  type ProcessGuardRecord,
} from '../src/process-guard';
import {
  inspectProcess,
  isProcessAlive,
  waitForProcessExit,
  type ProcessIdentity,
} from '../src/process-identity';
import { RealExecutor } from '../src/real-executor';
import { ExecutionRecovery, type RecoveryDependencies } from '../src/recovery';
import type { RepositoryContext } from '../src/repository-context';
import type { RepositoryPathPolicy } from '../src/repository-policy';
import { RunnerClient } from '../src/runner-client';
import {
  prepareProcessSupervisor,
  spawnSupervisedProcess,
  type SupervisedProcess,
} from '../src/supervised-process';

/**
 * R01-R12: real-operating-system evidence for the WP-D Slice 0 review findings.
 *
 * These tests deliberately start real processes. A marker is written by every
 * fixture so assertions can prove that the exact process (and its grandchild)
 * exited; they do not infer success from a PID alone. Every process started here
 * is terminated in `afterEach`.
 */

const roots: string[] = [];
const managedTrees: SupervisedProcess[] = [];
const spawnedProcesses: ChildProcess[] = [];
const trackedPids = new Set<number>();
const cliFixture = join(__dirname, 'fixtures', 'real-cli.cjs');
const runnerFixture = join(__dirname, 'fixtures', 'supervised-runner.ts');

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

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => boolean;
}

function unique(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-recovery-os-'));
  roots.push(root);
  return root;
}

function makeConfig(root: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    serverUrl: 'http://127.0.0.1:3001',
    runnerId: 'runner_recovery_os',
    computerId: 'computer_local',
    bootstrapToken: 'test-bootstrap-token',
    tokenFile: 'runner-recovery-os-token.json',
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
    ...overrides,
  };
}

function startPayload(executionId: string): ExecutionStartMessage['payload'] {
  return {
    executionId,
    runtime: 'codex',
    taskId: unique('task'),
    taskTitle: 'Recovery hardening OS test',
    taskDescription: 'Exercises real process-tree safety.',
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

function journalRecord(overrides: Partial<ExecutionJournalRecord> = {}): ExecutionJournalRecord {
  const executionId = overrides.executionId ?? unique('execution');
  const now = new Date().toISOString();
  return {
    version: 1,
    executionId,
    runtime: 'codex',
    projectId: 'project_demo',
    pid: null,
    processStartTime: null,
    processGroupId: null,
    worktreePath: null,
    branchName: null,
    baseCommit: null,
    phase: 'preparing',
    status: 'active',
    lastSequence: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    launchToken: null,
    guardPath: null,
    supervisorPid: null,
    supervisorStartTime: null,
    cliPid: null,
    cliStartTime: null,
    processKind: 'direct',
    spawnState: 'intent',
    recoveryBlockedReason: null,
    recoveryBlockedAt: null,
    recoveryNote: null,
    ...overrides,
  };
}

async function writeActiveJournal(root: string, record: ExecutionJournalRecord): Promise<void> {
  const journal = new ExecutionJournal(root);
  await journal.begin(record);
  await journal.flushAll();
}

async function waitForJson<T>(path: string, timeoutMs = 20_000): Promise<T> {
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
  timeoutMs = 20_000,
): Promise<CliMarker> {
  const deadline = Date.now() + timeoutMs;
  let marker = await waitForJson<CliMarker>(path, timeoutMs);
  if (!requireGrandchild) return marker;
  while (Date.now() < deadline) {
    if (marker.grandchildPid) return marker;
    await delay(20);
    marker = await waitForJson<CliMarker>(path, 2_000);
  }
  throw new Error(
    `CLI fixture never reported a grandchild PID (last marker: ${JSON.stringify(marker)}): ${path}`,
  );
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForIdentity(pid: number | undefined, timeoutMs = 10_000): Promise<ProcessIdentity> {
  if (!pid) throw new Error('process has no PID');
  let identity: ProcessIdentity | null = null;
  await waitFor(
    async () => {
      identity = await inspectProcess(pid);
      return identity !== null;
    },
    timeoutMs,
    `identity of PID ${pid}`,
  );
  return identity as unknown as ProcessIdentity;
}

function differentStartTime(startTime: string): string {
  if (/^\d+$/.test(startTime)) {
    return String(Number(startTime) + 10_000);
  }
  const parsed = Date.parse(startTime);
  if (Number.isNaN(parsed)) return '2000-01-01T00:00:00.000Z';
  return new Date(parsed - 60_000).toISOString();
}

async function forceKill(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function startUnrelatedProcess(marker: string): Promise<{
  child: ChildProcess;
  identity: ProcessIdentity;
}> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', marker],
    { stdio: 'ignore', windowsHide: true },
  );
  spawnedProcesses.push(child);
  if (child.pid) trackedPids.add(child.pid);
  const identity = await waitForIdentity(child.pid);
  return { child, identity };
}

async function startSupervisedTree(
  root: string,
  options: { executionId?: string; withGrandchild?: boolean } = {},
): Promise<{
  executionId: string;
  launchToken: string;
  guardPath: string;
  guard: ProcessGuardRecord;
  marker: CliMarker;
  managed: SupervisedProcess;
}> {
  const executionId = options.executionId ?? unique('execution');
  const launchToken = unique('token');
  const marker = unique('marker');
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const cliOut = join(artifacts, `cli-${marker}.json`);
  const guardPath = guardPathFor(root, executionId, launchToken);
  await prepareProcessSupervisor();
  const managed = await spawnSupervisedProcess({
    command: process.execPath,
    args: [
      cliFixture,
      marker,
      cliOut,
      options.withGrandchild === false ? '0' : '1',
      guardPath,
    ],
    cwd: process.cwd(),
    env: { ...process.env, HAFT_TEST_MARKER: marker },
    executionId,
    launchToken,
    recoveryRoot: root,
  });
  managedTrees.push(managed);
  const guard = await managed.ready;
  const cliMarker = await waitForCliMarker(cliOut, options.withGrandchild !== false);
  trackedPids.add(cliMarker.pid);
  if (cliMarker.grandchildPid) trackedPids.add(cliMarker.grandchildPid);
  return { executionId, launchToken, guardPath, guard, marker: cliMarker, managed };
}

function recoveryDependencies(overrides: Partial<RecoveryDependencies> = {}): RecoveryDependencies {
  return {
    inspectProcess,
    terminateProcessTree: async () => undefined,
    waitForProcessExit,
    readGuard: readProcessGuard,
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
  child.kill = () => true;
  return child;
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

afterEach(async () => {
  for (const managed of managedTrees.splice(0)) {
    await managed.terminate(true, 2_000).catch(() => undefined);
  }
  for (const child of spawnedProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  for (const pid of trackedPids) {
    await forceKill(pid);
  }
  trackedPids.clear();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 30_000);

describe('Recovery hardening real OS evidence (R01-R12)', () => {
  it(
    'R01: an active journal without a PID stays active and blocks recovery',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      await writeActiveJournal(root, journalRecord({ executionId, pid: null }));
      const journalPath = join(root, `${executionId}.json`);

      const recovery = new ExecutionRecovery(root, recoveryDependencies());
      const scan = await recovery.scan();
      const execution = scan.executions[0];

      expect(scan.blocked.some((entry) => entry.reason.includes('PID_NOT_RECORDED'))).toBe(true);
      expect(scan.clean).toBe(false);
      expect(execution?.recoveryBlocked).toBe(true);
      expect(execution?.processStateUnknown).toBe(true);
      expect(execution?.journalFinalized).toBe(false);
      expect(execution?.treeConfirmedGone).toBe(false);
      expect(existsSync(journalPath)).toBe(true);
      expect(JSON.parse(await readFile(journalPath, 'utf8')).status).toBe('active');
      expect(JSON.parse(await readFile(join(root, 'state', 'blocked.json'), 'utf8')).entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ executionId, reason: expect.stringContaining('PID_NOT_RECORDED') }),
        ]),
      );

      // The explicit operator entry point resolves blocked evidence only after
      // out-of-band verification; it never deletes the journal.
      expect(
        (await recovery.resolveBlockedExecution(executionId, 'operator confirmed no matching process'))
          .resolved,
      ).toBe(true);
      const rescan = await new ExecutionRecovery(root, recoveryDependencies()).scan();
      expect(rescan.clean).toBe(true);
      expect(JSON.parse(await readFile(journalPath, 'utf8')).status).toBe('interrupted');
      expect(existsSync(join(root, 'state', 'resolutions', `${executionId}.json`))).toBe(true);
    },
    30_000,
  );

  it(
    'R02: a crash before identity is durable leaves a guard; recovery proves the tree gone from it',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const launchToken = unique('token');
      const marker = unique('marker');
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts, { recursive: true });
      const cliOut = join(artifacts, `cli-${marker}.json`);
      const runnerOut = join(artifacts, `runner-${marker}.json`);
      const journalPath = join(root, `${executionId}.json`);
      const runner = spawn(process.execPath, ['--import', 'tsx', runnerFixture], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HAFT_TEST_RECOVERY_ROOT: root,
          HAFT_TEST_EXECUTION_ID: executionId,
          HAFT_TEST_LAUNCH_TOKEN: launchToken,
          HAFT_TEST_MARKER: marker,
          HAFT_TEST_CLI_OUT: cliOut,
          HAFT_TEST_RUNNER_OUT: runnerOut,
          HAFT_TEST_SKIP_IDENTITY: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      spawnedProcesses.push(runner);
      try {
        const runnerInfo = await waitForJson<{
          runnerPid: number;
          supervisorPid: number;
          cliPid: number;
          guardPath: string;
        }>(runnerOut, 30_000);
        const cli = await waitForCliMarker(cliOut, true, 10_000);
        trackedPids.add(runnerInfo.runnerPid);
        trackedPids.add(runnerInfo.supervisorPid);
        trackedPids.add(runnerInfo.cliPid);
        if (cli.grandchildPid) trackedPids.add(cli.grandchildPid);

        // The CLI was created only after the guard existed.
        expect(cli.guardPresent).toBe(true);
        // The journal is still the launch intent: no PID and no identity.
        const intent = JSON.parse(await readFile(journalPath, 'utf8'));
        expect(intent.status).toBe('active');
        expect(intent.pid).toBeNull();
        expect(intent.processKind).toBe('supervisor');
        expect(intent.guardPath).toBe(runnerInfo.guardPath);

        // Kill the "previous runner" abruptly. No recovery code runs first.
        runner.kill('SIGKILL');
        await waitFor(
          () => !isProcessAlive(runnerInfo.cliPid) && (!cli.grandchildPid || !isProcessAlive(cli.grandchildPid)),
          20_000,
          'supervisor parent-death cleanup',
        );

        const scan = await new ExecutionRecovery(root, recoveryDependencies()).scan();
        expect(scan.blocked).toEqual([]);
        expect(scan.executions).toHaveLength(1);
        expect(scan.executions[0]?.treeConfirmedGone).toBe(true);
        expect(scan.executions[0]?.journalFinalized).toBe(true);
        expect(scan.executions[0]?.recoveryBlocked).toBe(false);

        const finalized = JSON.parse(await readFile(journalPath, 'utf8'));
        expect(finalized.status).toBe('interrupted');
        expect(await waitForProcessExit(cli.pid, 1_000)).toBe(true);
        if (cli.grandchildPid) {
          expect(await waitForProcessExit(cli.grandchildPid, 1_000)).toBe(true);
        }
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      }
    },
    90_000,
  );

  it(
    'R03: recovery terminates a live guarded tree through the supervisor and verifies every member',
    async () => {
      const root = await makeRoot();
      const tree = await startSupervisedTree(root);
      expect(tree.guard.cliPid).toBe(tree.marker.pid);
      expect(tree.marker.grandchildPid).not.toBeNull();

      if (process.platform === 'linux' && tree.guard.isolation === 'linux-cgroup') {
        const members = await readCgroupMembers(tree.guard.cgroupPath as string);
        expect(members.pids).toEqual(
          expect.arrayContaining([tree.guard.cliPid, tree.marker.grandchildPid]),
        );
      }

      await writeActiveJournal(root, {
        ...journalRecord({
          executionId: tree.executionId,
          pid: tree.guard.supervisorPid,
          processStartTime: tree.guard.supervisorStartTime,
          processGroupId: tree.guard.processGroupId,
          cliPid: tree.guard.cliPid,
          cliStartTime: tree.guard.cliStartTime,
          processKind: 'supervisor',
          spawnState: 'running',
          phase: 'running',
        }),
        launchToken: tree.launchToken,
        guardPath: tree.guardPath,
      });

      const scan = await new ExecutionRecovery(root, recoveryDependencies()).scan();
      const execution = scan.executions[0];
      expect(scan.blocked).toEqual([]);
      expect(execution?.orphanTerminated).toBe(true);
      expect(execution?.treeConfirmedGone).toBe(true);
      expect(execution?.journalFinalized).toBe(true);

      expect(await waitForProcessExit(tree.marker.pid, 5_000)).toBe(true);
      if (tree.marker.grandchildPid) {
        expect(await waitForProcessExit(tree.marker.grandchildPid, 5_000)).toBe(true);
      }
      expect(await waitForProcessExit(tree.guard.supervisorPid, 5_000)).toBe(true);
      const onDisk = JSON.parse(await readFile(join(root, `${tree.executionId}.json`), 'utf8'));
      expect(onDisk.status).toBe('interrupted');
    },
    90_000,
  );

  it(
    'R04: termination never kills a PID whose recorded identity no longer matches',
    async () => {
      const root = await makeRoot();
      const unrelated = await startUnrelatedProcess(unique('unrelated'));
      const executionId = unique('execution');
      const guard: ProcessGuardRecord = {
        version: 1,
        executionId,
        launchToken: unique('token'),
        parentPid: process.pid,
        supervisorPid: unrelated.identity.pid,
        supervisorStartTime: differentStartTime(unrelated.identity.startTime),
        processGroupId: null,
        cgroupPath: null,
        cliPid: null,
        cliStartTime: null,
        isolation:
          process.platform === 'win32'
            ? 'windows-job'
            : process.platform === 'linux'
              ? 'linux-cgroup'
              : 'posix-group',
        state: 'running',
        jobCreated: true,
        treeConfirmedGone: false,
        exitCode: null,
        signal: null,
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const terminate = vi.fn(async () => undefined);
      const result = await terminateGuardedTree(
        guard,
        null,
        {
          inspectProcess,
          terminateProcessTree: terminate,
          waitForProcessExit,
        },
        { supervisorConfirmMs: 100, verifyTimeoutMs: 100 },
      );

      expect(result.identityMismatch).toBe(true);
      expect(result.confirmed).toBe(false);
      expect(result.killIssued).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
      expect(isProcessAlive(unrelated.identity.pid)).toBe(true);
      expect(root.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'R04b: a failed taskkill is reported as unconfirmed and the target stays alive',
    async () => {
      const root = await makeRoot();
      const tree = await startSupervisedTree(root);
      const result = await terminateGuardedTree(
        tree.guard,
        null,
        {
          inspectProcess,
          terminateProcessTree: async () => undefined,
          waitForProcessExit,
        },
        {
          // node.exe exits non-zero when asked to run `/pid ...`; the real
          // terminateProcessTree must surface that as a taskkill failure.
          taskkillBinary: process.execPath,
          supervisorConfirmMs: 100,
          verifyTimeoutMs: 100,
        },
      );

      expect(result.confirmed).toBe(false);
      expect(result.killIssued).toBe(true);
      expect(result.reason).toMatch(/taskkill|exited with code/i);
      expect(isProcessAlive(tree.guard.supervisorPid)).toBe(true);
    },
    60_000,
  );

  it(
    'R05: a post-spawn identity failure terminates the real tree before the failed journal is final',
    async () => {
      const root = await makeRoot();
      const worktreePath = join(root, 'worktree');
      await mkdir(worktreePath, { recursive: true });
      const executionId = unique('execution');
      const marker = unique('marker');
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts, { recursive: true });
      const cliOut = join(artifacts, `cli-${marker}.json`);
      const recovery = new ExecutionRecovery(root, recoveryDependencies());
      const { captured, callbacks } = capturedCallbacks();

      const originalUpdate = recovery.journal.update.bind(recovery.journal);
      vi.spyOn(recovery.journal, 'update').mockImplementation(async (id, patch, options) => {
        if (patch.pid && patch.processKind === 'supervisor') {
          throw new Error('injected identity write failure');
        }
        return originalUpdate(id, patch, options);
      });
      let pidsAtFinish: number[] = [];
      const originalFinish = recovery.journal.finish.bind(recovery.journal);
      vi.spyOn(recovery.journal, 'finish').mockImplementation(async (...args) => {
        pidsAtFinish = [markerState?.pid, markerState?.grandchildPid]
          .filter((value): value is number => typeof value === 'number')
          .map((pid) => (isProcessAlive(pid) ? pid : 0))
          .filter((pid) => pid !== 0);
        return originalFinish(...args);
      });
      let markerState: CliMarker | null = null;

      const executor = new RealExecutor(makeConfig(root), callbacks, recovery, {
        resolveExecutable: async () => ({ path: process.execPath, searched: [], error: null }),
        probeAuthentication: async () => ({ authenticated: true, message: null }),
        buildArgs: () => [cliFixture, marker, cliOut, '1'],
        inspectProcess: async (pid: number) => {
          const identity = await inspectProcess(pid);
          if (
            identity?.commandLine &&
            /process-supervisor|haft-process-supervisor/i.test(identity.commandLine)
          ) {
            // Give the CLI fixture time to write its marker; the identity
            // failure itself happens immediately after `managed.ready`.
            await delay(400);
            return null;
          }
          return identity;
        },
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
        shutdownForceWaitMs: 500,
      });

      const payload = startPayload(executionId);
      const context = repositoryContext(executionId, worktreePath);
      expect(await executor.canAdmit(payload, context)).toEqual({ ok: true });
      executor.start(payload, context);

      markerState = await waitForJson<CliMarker>(cliOut, 30_000);
      if (!markerState.grandchildPid) {
        await waitFor(
          async () => {
            markerState = await waitForJson<CliMarker>(cliOut, 2_000);
            return markerState.grandchildPid !== null;
          },
          10_000,
          'grandchild PID',
        );
      }
      trackedPids.add(markerState.pid);
      if (markerState.grandchildPid) trackedPids.add(markerState.grandchildPid);
      await waitFor(() => captured.failed.length === 1, 30_000, 'post-spawn failure report');

      expect(captured.completed).toEqual([]);
      expect(captured.cancelled).toEqual([]);
      expect(captured.failed[0]?.payload.reason).toContain('RECOVERY_JOURNAL_PID_IDENTITY_FAILED');
      expect(pidsAtFinish).toEqual([]);
      expect(await waitForProcessExit(markerState.pid, 5_000)).toBe(true);
      if (markerState.grandchildPid) {
        expect(await waitForProcessExit(markerState.grandchildPid, 5_000)).toBe(true);
      }
      expect(JSON.parse(await readFile(join(root, `${executionId}.json`), 'utf8')).status).toBe(
        'failed',
      );
      const scan = await new ExecutionRecovery(root, recoveryDependencies()).scan();
      expect(scan.blocked).toEqual([]);
      expect(scan.executions).toEqual([]);
    },
    90_000,
  );

  it(
    'R06: the 15s terminal fallback re-checks the tree and keeps the journal active on the fake clock',
    async () => {
      vi.useFakeTimers();
      try {
        const root = await makeRoot();
        const executionId = unique('execution');
        const journal = {
          begin: vi.fn().mockResolvedValue(undefined),
          update: vi.fn().mockResolvedValue(undefined),
          finish: vi.fn().mockResolvedValue(undefined),
          flushAll: vi.fn().mockResolvedValue(undefined),
          setBackgroundErrorHandler: vi.fn(),
        };
        const recovery = {
          journal,
          spool: { flush: vi.fn() },
          isWorktreeBlocked: () => false,
        } as unknown as ExecutionRecovery;
        const { captured, callbacks } = capturedCallbacks();
        const child = createFakeChild();
        const terminateProcess = vi.fn(async () => {
          throw new Error('injected termination failure');
        });
        const executor = new RealExecutor(makeConfig(root), callbacks, recovery, {
          resolveExecutable: async () => ({ path: '/virtual/codex', searched: [], error: null }),
          probeAuthentication: async () => ({ authenticated: true, message: null }),
          spawnProcess: () => child as unknown as ChildProcess,
          buildArgs: () => [],
          inspectProcess: async (pid: number) => ({
            pid,
            parentPid: 1,
            processGroupId: pid,
            startTime: 'start-test',
            commandLine: 'codex exec',
          }),
          terminateProcess,
          waitForProcessExit: async () => false,
          repositoryPolicy: fakeRepositoryPolicy(),
          git: {
            prepare: async () => ({
              path: join(root, 'worktree'),
              branchName: `haft/${executionId}`,
              baseCommit: 'a'.repeat(40),
            }),
            collect: async () => null,
            cleanup: async () => ({ path: '', removed: false }),
          },
          shutdownForceWaitMs: 100,
        });

        const payload = startPayload(executionId);
        executor.start(payload, repositoryContext(executionId, join(root, 'worktree')));
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (captured.phases.some((phase) => phase.phase === 'running')) break;
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(captured.phases.some((phase) => phase.phase === 'running')).toBe(true);

        executor.cancel(executionId, 'R06 cancel');
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(journal.finish).not.toHaveBeenCalled();
        expect(captured.completed).toEqual([]);
        expect(captured.failed).toEqual([]);
        expect(captured.cancelled).toEqual([]);
        expect(executor.snapshot().map((session) => session.executionId)).toContain(executionId);
        expect(
          captured.logs.some((entry) =>
            entry.entry.message.includes('recovery journal was left active'),
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
    30_000,
  );

  it(
    'R07: a corrupt journal is quarantined as evidence while other records still recover',
    async () => {
      const root = await makeRoot();
      const corruptPath = join(root, 'broken.json');
      const original = '{"version":1,"executionId":';
      await writeFile(corruptPath, original, 'utf8');
      const validExecutionId = unique('execution');
      await writeActiveJournal(
        root,
        journalRecord({ executionId: validExecutionId, pid: null }),
      );

      const recovery = new ExecutionRecovery(root, recoveryDependencies());
      const scan = await recovery.scan();
      expect(scan.clean).toBe(false);
      expect(scan.corrupted).toHaveLength(1);
      expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
      // A damaged record must not stop the remaining records from being scanned.
      expect(scan.executions.map((entry) => entry.record.executionId)).toContain(validExecutionId);
      expect(
        scan.blocked.some(
          (entry) =>
            entry.executionId === validExecutionId &&
            entry.reason.includes('PID_NOT_RECORDED'),
        ),
      ).toBe(true);
      const quarantined = scan.corrupted[0]?.quarantinedPath;
      expect(quarantined).toBeTruthy();
      expect(existsSync(quarantined as string)).toBe(true);
      expect(await readFile(quarantined as string, 'utf8')).toBe(original);
      expect(existsSync(corruptPath)).toBe(false);

      expect(
        (await recovery.resolveCorruptJournal(quarantined as string, 'operator inspected the file'))
          .resolved,
      ).toBe(true);
      expect(
        (await recovery.resolveBlockedExecution(validExecutionId, 'no matching process remains'))
          .resolved,
      ).toBe(true);
      const cleanScan = await new ExecutionRecovery(root, recoveryDependencies()).scan();
      expect(cleanScan.clean).toBe(true);
      expect(cleanScan.corrupted).toEqual([]);
      expect(
        JSON.parse(await readFile(join(root, `${validExecutionId}.json`), 'utf8')).status,
      ).toBe('interrupted');
    },
    30_000,
  );

  it(
    'R08: a blocked scan rejects new work and advertises degraded readiness',
    async () => {
      const root = await makeRoot();
      await writeFile(join(root, 'broken.json'), 'not-json', 'utf8');
      const scan = await new ExecutionRecovery(root, recoveryDependencies()).scan();
      const config = makeConfig(root, {
        mode: 'fake',
        fakeRuntimes: ['codex'],
        realRuntimes: [],
      });
      const client = new RunnerClient({
        config,
        repositoryPolicy: fakeRepositoryPolicy(),
        recovery: new ExecutionRecovery(root, recoveryDependencies()),
      });
      const envelopes: RunnerEnvelope[] = [];
      const fakeSocket = {
        connected: true,
        emit: (_event: string, envelope: RunnerEnvelope) => {
          envelopes.push(envelope);
        },
        removeAllListeners: () => undefined,
        disconnect: () => undefined,
      };
      (client as unknown as { socket: unknown }).socket = fakeSocket;

      client.applyRecoveryScan(scan);
      expect(client.isRecoveryBlocked()).toBe(true);
      expect(client.recoveryBlockedReason()).toContain('CORRUPT');

      const executionId = unique('execution');
      await (
        client as unknown as { runAdmission(payload: ExecutionStartMessage['payload']): Promise<void> }
      ).runAdmission(startPayload(executionId));
      const rejected = envelopes.find(
        (envelope) =>
          envelope.type === 'execution.start.rejected' &&
          (envelope.payload as { executionId?: string }).executionId === executionId,
      );
      expect(rejected).toBeDefined();
      expect((rejected?.payload as { code?: string }).code).toBe(
        ERROR_CODES.RUNNER_START_UNCONFIRMED,
      );
      expect((rejected?.payload as { message?: string }).message).toContain(
        'RUNNER_RECOVERY_BLOCKED',
      );

      (
        client as unknown as { startHeartbeat(): void; stopHeartbeat(): void }
      ).startHeartbeat();
      const heartbeat = envelopes.find((envelope) => envelope.type === 'runner.heartbeat');
      expect((heartbeat?.payload as { status?: string }).status).toBe('degraded');
      (client as unknown as { stopHeartbeat(): void }).stopHeartbeat();

      const port = await freePort();
      const server = startHealthServer(port, config.runnerId, client);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`);
        expect(response.status).toBe(503);
        const body = (await response.json()) as { status?: string; recoveryBlocked?: boolean };
        expect(body.status).toBe('degraded');
        expect(body.recoveryBlocked).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      }
    },
    60_000,
  );

  it(
    'R09: a journal finalization failure sends no terminal event and keeps the active record',
    async () => {
      const root = await makeRoot();
      const worktreePath = join(root, 'worktree');
      await mkdir(worktreePath, { recursive: true });
      const executionId = unique('execution');
      const marker = unique('marker');
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts, { recursive: true });
      const cliOut = join(artifacts, `cli-${marker}.json`);
      const recovery = new ExecutionRecovery(root, recoveryDependencies());
      vi.spyOn(recovery.journal, 'finish').mockRejectedValue(new Error('injected journal disk failure'));
      const { captured, callbacks } = capturedCallbacks();

      const executor = new RealExecutor(makeConfig(root), callbacks, recovery, {
        resolveExecutable: async () => ({ path: process.execPath, searched: [], error: null }),
        probeAuthentication: async () => ({ authenticated: true, message: null }),
        buildArgs: () => [cliFixture, marker, cliOut, '1', 'none', '250'],
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
        shutdownForceWaitMs: 500,
      });

      const payload = startPayload(executionId);
      const context = repositoryContext(executionId, worktreePath);
      expect(await executor.canAdmit(payload, context)).toEqual({ ok: true });
      executor.start(payload, context);
      const cli = await waitForCliMarker(cliOut, true, 30_000);
      trackedPids.add(cli.pid);
      if (cli.grandchildPid) trackedPids.add(cli.grandchildPid);

      await waitFor(
        () =>
          captured.logs.some((entry) =>
            entry.entry.message.includes('no terminal event will be sent'),
          ),
        30_000,
        'journal uncertainty latch',
      );

      expect(captured.completed).toEqual([]);
      expect(captured.failed).toEqual([]);
      expect(captured.cancelled).toEqual([]);
      expect(executor.snapshot().map((session) => session.executionId)).toContain(executionId);
      expect(JSON.parse(await readFile(join(root, `${executionId}.json`), 'utf8')).status).toBe(
        'active',
      );
      expect(await waitForProcessExit(cli.pid, 5_000)).toBe(true);
      if (cli.grandchildPid) {
        expect(await waitForProcessExit(cli.grandchildPid, 5_000)).toBe(true);
      }

      const shutdown = await executor.shutdown('R09 shutdown');
      expect(shutdown.clean).toBe(false);
      expect(shutdown.remainingExecutionIds).toContain(executionId);
      expect(captured.failed).toEqual([]);
    },
    90_000,
  );

  it(
    'R10: recovery leaves a live reused PID untouched and blocks with its identity evidence',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const unrelated = await startUnrelatedProcess(unique('unrelated'));
      await writeActiveJournal(
        root,
        journalRecord({
          executionId,
          pid: unrelated.identity.pid,
          processStartTime: differentStartTime(unrelated.identity.startTime),
          processGroupId: unrelated.identity.processGroupId,
          phase: 'running',
        }),
      );
      const terminate = vi.fn(async () => undefined);
      const scan = await new ExecutionRecovery(
        root,
        recoveryDependencies({ terminateProcessTree: terminate }),
      ).scan();

      expect(scan.executions[0]?.recoveryBlocked).toBe(true);
      expect(scan.executions[0]?.pidReused).toBe(true);
      expect(scan.blocked[0]?.reason).toContain('PID_REUSED');
      expect(terminate).not.toHaveBeenCalled();
      expect(isProcessAlive(unrelated.identity.pid)).toBe(true);
      expect(JSON.parse(await readFile(join(root, `${executionId}.json`), 'utf8')).status).toBe(
        'active',
      );
    },
    30_000,
  );

  it(
    'R11: recovery never assumes absent from an incomplete identity and never kills the PID',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const unrelated = await startUnrelatedProcess(unique('unrelated'));
      await writeActiveJournal(
        root,
        journalRecord({
          executionId,
          pid: unrelated.identity.pid,
          processStartTime: null,
          processGroupId: unrelated.identity.processGroupId,
          phase: 'running',
        }),
      );
      const terminate = vi.fn(async () => undefined);
      const scan = await new ExecutionRecovery(
        root,
        recoveryDependencies({ terminateProcessTree: terminate }),
      ).scan();

      expect(scan.executions[0]?.recoveryBlocked).toBe(true);
      expect(scan.executions[0]?.processIdentityUnverified).toBe(true);
      expect(scan.executions[0]?.processStateUnknown).toBe(true);
      expect(scan.blocked[0]?.reason).toContain('PID_IDENTITY_UNVERIFIED');
      expect(terminate).not.toHaveBeenCalled();
      expect(isProcessAlive(unrelated.identity.pid)).toBe(true);
    },
    30_000,
  );

  it(
    'R11b: a failed identity inspection never proves a live PID absent',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const unrelated = await startUnrelatedProcess(unique('unrelated'));
      await writeActiveJournal(
        root,
        journalRecord({
          executionId,
          pid: unrelated.identity.pid,
          processStartTime: unrelated.identity.startTime,
          processGroupId: unrelated.identity.processGroupId,
          phase: 'running',
        }),
      );
      const terminate = vi.fn(async () => undefined);
      const scan = await new ExecutionRecovery(
        root,
        recoveryDependencies({
          inspectProcess: async () => null,
          terminateProcessTree: terminate,
        }),
      ).scan();

      expect(scan.clean).toBe(false);
      expect(scan.executions[0]?.recoveryBlocked).toBe(true);
      expect(scan.executions[0]?.processStateUnknown).toBe(true);
      expect(scan.blocked[0]?.reason).toContain('PID_IDENTITY_UNVERIFIED');
      expect(terminate).not.toHaveBeenCalled();
      expect(isProcessAlive(unrelated.identity.pid)).toBe(true);
      expect(JSON.parse(await readFile(join(root, `${executionId}.json`), 'utf8')).status).toBe(
        'active',
      );
    },
    30_000,
  );

  it(
    'R12: a worktree attached to a blocked execution is never reused',
    async () => {
      const root = await makeRoot();
      const blockedWorktree = join(root, 'worktrees', 'blocked');
      await mkdir(blockedWorktree, { recursive: true });
      const blockedExecutionId = unique('blocked');
      await writeActiveJournal(
        root,
        journalRecord({
          executionId: blockedExecutionId,
          pid: null,
          worktreePath: blockedWorktree,
          phase: 'running',
        }),
      );
      const recovery = new ExecutionRecovery(root, recoveryDependencies());
      const scan = await recovery.scan();
      expect(scan.clean).toBe(false);
      expect(recovery.isWorktreeBlocked(blockedWorktree)).toBe(true);

      const { captured, callbacks } = capturedCallbacks();
      const spawnProcess = vi.fn();
      const executionId = unique('execution');
      const executor = new RealExecutor(makeConfig(root), callbacks, recovery, {
        resolveExecutable: async () => ({ path: '/virtual/codex', searched: [], error: null }),
        probeAuthentication: async () => ({ authenticated: true, message: null }),
        spawnProcess: spawnProcess as never,
        buildArgs: () => [],
        repositoryPolicy: fakeRepositoryPolicy(),
        git: {
          prepare: async () => ({
            path: blockedWorktree,
            branchName: `haft/${executionId}`,
            baseCommit: 'a'.repeat(40),
          }),
          collect: async () => null,
          cleanup: async () => ({ path: blockedWorktree, removed: false }),
        },
        shutdownForceWaitMs: 100,
      });

      const payload = startPayload(executionId);
      const context = repositoryContext(executionId, blockedWorktree);
      expect(await executor.canAdmit(payload, context)).toEqual({ ok: true });
      executor.start(payload, context);
      await waitFor(() => captured.failed.length === 1, 30_000, 'blocked worktree rejection');

      expect(captured.failed[0]?.payload.reason).toContain('RECOVERY_BLOCKED_WORKTREE');
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(existsSync(blockedWorktree)).toBe(true);
    },
    30_000,
  );
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
