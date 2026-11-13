import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { guardPathFor, type ProcessGuardRecord } from '../src/process-guard';
import {
  spawnSupervisedProcess,
  waitForGuardReady,
  type SupervisedProcess,
  type SupervisorLaunchSpec,
} from '../src/supervised-process';

const roots: string[] = [];
const managedProcesses: SupervisedProcess[] = [];
const cliFixture = join(__dirname, 'fixtures', 'real-cli.cjs');
const noGuardSupervisor = join(__dirname, 'fixtures', 'no-guard-supervisor.cjs');

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function unique(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-supervisor-safety-'));
  roots.push(root);
  return root;
}

function makeSpec(root: string, executionId: string, launchToken: string): SupervisorLaunchSpec {
  return {
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: { ...process.env },
    executionId,
    launchToken,
    recoveryRoot: root,
  };
}

function makeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function guardRecord(
  executionId: string,
  launchToken: string,
  supervisorPid: number,
  state: ProcessGuardRecord['state'],
): ProcessGuardRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    executionId,
    launchToken,
    parentPid: process.pid,
    supervisorPid,
    supervisorStartTime: 'start-test',
    processGroupId: supervisorPid,
    cgroupPath: null,
    cliPid: null,
    cliStartTime: null,
    isolation: 'posix-group',
    state,
    jobCreated: true,
    treeConfirmedGone: false,
    exitCode: null,
    signal: null,
    detail: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function writeGuard(path: string, guard: ProcessGuardRecord): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(guard, null, 2)}\n`, 'utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

afterEach(async () => {
  for (const managed of managedProcesses.splice(0)) {
    await managed.terminate(true, 100).catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Supervisor ready/cleanup safety (S1-S8)', () => {
  it('S1: a supervisor that exits before writing a guard is never reported ready', async () => {
    const root = await makeRoot();
    const executionId = unique('execution');
    const launchToken = unique('token');
    const spec = makeSpec(root, executionId, launchToken);
    const guardPath = guardPathFor(root, executionId, launchToken);
    const child = makeChild();

    const ready = waitForGuardReady(child as unknown as ChildProcess, guardPath, spec, 1_000);
    setTimeout(() => {
      child.exitCode = 70;
      child.emit('exit', 70, null);
    }, 50);

    await expect(ready).rejects.toThrow(/PROCESS_SUPERVISOR_EXITED/);
    expect(existsSync(guardPath)).toBe(false);
  });

  it('S2: a starting guard that disappears after it was written is not ready', async () => {
    const root = await makeRoot();
    const executionId = unique('execution');
    const launchToken = unique('token');
    const spec = makeSpec(root, executionId, launchToken);
    const guardPath = guardPathFor(root, executionId, launchToken);
    const child = makeChild();
    await writeGuard(guardPath, guardRecord(executionId, launchToken, child.pid, 'starting'));

    const ready = waitForGuardReady(child as unknown as ChildProcess, guardPath, spec, 1_000);
    setTimeout(async () => {
      await rm(guardPath, { force: true });
      child.exitCode = 70;
      child.emit('exit', 70, null);
    }, 60);

    await expect(ready).rejects.toThrow(/PROCESS_SUPERVISOR_EXITED/);
  });

  it('S3: an unreadable guard is never treated as a running tree', async () => {
    const root = await makeRoot();
    const executionId = unique('execution');
    const launchToken = unique('token');
    const spec = makeSpec(root, executionId, launchToken);
    const guardPath = guardPathFor(root, executionId, launchToken);
    await mkdir(guardPath, { recursive: true });
    const child = makeChild();

    const ready = waitForGuardReady(child as unknown as ChildProcess, guardPath, spec, 150);

    await expect(ready).rejects.toThrow(/PROCESS_SUPERVISOR_TIMEOUT: Could not read process guard/);
  });

  it('S4: a failed guard rejects ready with the supervisor failure reason', async () => {
    const root = await makeRoot();
    const executionId = unique('execution');
    const launchToken = unique('token');
    const spec = makeSpec(root, executionId, launchToken);
    const guardPath = guardPathFor(root, executionId, launchToken);
    const child = makeChild();
    await writeGuard(guardPath, guardRecord(executionId, launchToken, child.pid, 'failed'));

    await expect(
      waitForGuardReady(child as unknown as ChildProcess, guardPath, spec, 500),
    ).rejects.toThrow(/PROCESS_SUPERVISOR_FAILED/);
  });

  it('S5: a normal running guard resolves ready', async () => {
    const root = await makeRoot();
    const executionId = unique('execution');
    const launchToken = unique('token');
    const spec = makeSpec(root, executionId, launchToken);
    const guardPath = guardPathFor(root, executionId, launchToken);
    const child = makeChild();
    setTimeout(() => {
      void writeGuard(guardPath, guardRecord(executionId, launchToken, child.pid, 'running'));
    }, 40);

    const guard = await waitForGuardReady(child as unknown as ChildProcess, guardPath, spec, 1_000);

    expect(guard.state).toBe('running');
    expect(guard.supervisorPid).toBe(child.pid);
  });

  it.skipIf(process.platform === 'win32')(
    'S6: a rejected ready never makes terminate or verifyTreeGone throw or claim confirmation',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const launchToken = unique('token');
      const previous = process.env.HAFT_PROCESS_SUPERVISOR;
      process.env.HAFT_PROCESS_SUPERVISOR = noGuardSupervisor;
      try {
        const managed = await spawnSupervisedProcess({
          command: process.execPath,
          args: [],
          cwd: process.cwd(),
          env: { ...process.env },
          executionId,
          launchToken,
          recoveryRoot: root,
        });
        managedProcesses.push(managed);
        await expect(managed.ready).rejects.toThrow(/PROCESS_SUPERVISOR_EXITED/);

        const termination = await managed.terminate(true, 100);
        const verification = await managed.verifyTreeGone(100);

        expect(termination.requested).toBe(true);
        expect(termination.confirmed).toBe(false);
        expect(termination.killIssued).toBe(false);
        expect(termination.reason).toContain('PROCESS_SUPERVISOR_NOT_READY');
        expect(verification.confirmed).toBe(false);
        expect(verification.identityMismatch).toBe(false);
        expect(verification.reason).toContain('PROCESS_SUPERVISOR_NOT_READY');
      } finally {
        if (previous === undefined) delete process.env.HAFT_PROCESS_SUPERVISOR;
        else process.env.HAFT_PROCESS_SUPERVISOR = previous;
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'S8: cleanup of a supervisor stuck before its guard is bounded and unconfirmed',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const launchToken = unique('token');
      const previous = process.env.HAFT_PROCESS_SUPERVISOR;
      process.env.HAFT_PROCESS_SUPERVISOR = noGuardSupervisor;
      try {
        const managed = await spawnSupervisedProcess({
          command: process.execPath,
          args: [],
          cwd: process.cwd(),
          env: { ...process.env, HAFT_TEST_HANG: '1' },
          executionId,
          launchToken,
          recoveryRoot: root,
        });
        managedProcesses.push(managed);

        const startedAt = Date.now();
        const termination = await managed.terminate(true, 200);
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(10_000);
        expect(termination.requested).toBe(true);
        expect(termination.confirmed).toBe(false);
        expect(termination.killIssued).toBe(true);
        expect(termination.reason).toContain('PROCESS_SUPERVISOR_NOT_READY');
        expect(termination.reason).toContain('not readable within 200 ms');
        await expect(managed.ready).rejects.toThrow(/PROCESS_SUPERVISOR_EXITED/);
      } finally {
        if (previous === undefined) delete process.env.HAFT_PROCESS_SUPERVISOR;
        else process.env.HAFT_PROCESS_SUPERVISOR = previous;
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'S7: Windows starting-guard failure blocks SpawnCli and cleanup stays unconfirmed',
    async () => {
      const root = await makeRoot();
      const executionId = unique('execution');
      const launchToken = unique('token');
      const marker = unique('marker');
      const cliOut = join(root, 'artifacts', `cli-${marker}.json`);
      await mkdir(join(root, 'artifacts'), { recursive: true });
      const guardPath = guardPathFor(root, executionId, launchToken);
      // A directory at the guard path makes the supervisor's File.Replace /
      // File.Move fail deterministically; this is a fault injection, not a
      // real disk-full dependency.
      await mkdir(guardPath, { recursive: true });

      const managed = await spawnSupervisedProcess({
        command: process.execPath,
        args: [cliFixture, marker, cliOut, '0', 'none'],
        cwd: process.cwd(),
        env: { ...process.env, HAFT_TEST_MARKER: marker },
        executionId,
        launchToken,
        recoveryRoot: root,
      });
      managedProcesses.push(managed);

      await expect(managed.ready).rejects.toThrow(/PROCESS_SUPERVISOR_EXITED/);
      const termination = await managed.terminate(true, 500);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(existsSync(cliOut)).toBe(false);
      expect(termination.confirmed).toBe(false);
      expect(termination.killIssued).toBe(false);
      expect(errorMessage(termination.reason)).toContain('PROCESS_SUPERVISOR_NOT_READY');
    },
    120_000,
  );
});
