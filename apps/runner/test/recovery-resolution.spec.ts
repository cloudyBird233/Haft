import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionJournalRecord } from '../src/execution-journal';
import { inspectProcess, type ProcessIdentity } from '../src/process-identity';
import type { ProcessGuardRecord } from '../src/process-guard';
import { ExecutionRecovery, type RecoveryDependencies } from '../src/recovery';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-recovery-resolution-'));
  roots.push(root);
  return root;
}

function journalRecord(overrides: Partial<ExecutionJournalRecord> = {}): ExecutionJournalRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    executionId: 'execution_recovery_resolution',
    runtime: 'codex',
    projectId: 'project_demo',
    pid: null,
    processStartTime: null,
    processGroupId: null,
    worktreePath: null,
    branchName: null,
    baseCommit: null,
    phase: 'running',
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

function guardRecord(overrides: Partial<ProcessGuardRecord> = {}): ProcessGuardRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    executionId: 'execution_recovery_resolution',
    launchToken: 'token-recovery-resolution',
    parentPid: process.pid,
    supervisorPid: 999_999,
    supervisorStartTime: 'start-recorded',
    processGroupId: null,
    cgroupPath: null,
    cliPid: null,
    cliStartTime: null,
    isolation: 'windows-job',
    state: 'running',
    jobCreated: true,
    treeConfirmedGone: false,
    exitCode: null,
    signal: null,
    detail: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function dependencies(overrides: Partial<RecoveryDependencies> = {}): RecoveryDependencies {
  return {
    inspectProcess: vi.fn().mockResolvedValue(null),
    terminateProcessTree: vi.fn().mockResolvedValue(undefined),
    waitForProcessExit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function identity(pid: number, startTime: string): ProcessIdentity {
  return {
    pid,
    parentPid: 1,
    processGroupId: pid,
    startTime,
    commandLine: 'codex exec',
  };
}

async function writeGuard(root: string, guard: ProcessGuardRecord): Promise<string> {
  const directory = join(root, 'guards');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${guard.executionId}.${guard.launchToken}.guard.json`);
  await writeFile(path, `${JSON.stringify(guard, null, 2)}\n`, 'utf8');
  return path;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Recovery operator resolution hardening (R13-R19)', () => {
  it('R13: resolve-corrupt rejects arbitrary files and directories', async () => {
    const root = await makeRoot();
    const recovery = new ExecutionRecovery(root, dependencies());
    const arbitrary = join(root, 'notes.json');
    await writeFile(arbitrary, 'ordinary operator note', 'utf8');
    const directory = join(root, 'broken.json.corrupt-123');
    await mkdir(directory);
    const nestedDirectory = join(root, 'nested');
    await mkdir(nestedDirectory);
    const nested = join(nestedDirectory, 'broken.json.corrupt-789');
    await writeFile(nested, '{"partial":true}', 'utf8');

    const arbitraryResult = await recovery.resolveCorruptJournal(arbitrary, 'looks safe to me');
    const directoryResult = await recovery.resolveCorruptJournal(directory, 'looks safe to me');
    const nestedResult = await recovery.resolveCorruptJournal(nested, 'looks safe to me');
    const outsideResult = await recovery.resolveCorruptJournal(
      join(root, '..', 'outside.json.corrupt-123'),
      'looks safe to me',
    );

    expect(arbitraryResult.resolved).toBe(false);
    expect(arbitraryResult.reason).toContain('quarantined corrupt journal');
    expect(directoryResult.resolved).toBe(false);
    expect(directoryResult.reason).toContain('regular quarantined corrupt journal');
    expect(nestedResult.resolved).toBe(false);
    expect(nestedResult.reason).toContain('not a quarantined corrupt journal in the recovery root');
    expect(outsideResult.resolved).toBe(false);
    expect(outsideResult.reason).toContain('outside the recovery root');
    expect(existsSync(`${arbitrary}.resolution.json`)).toBe(false);
    expect(existsSync(`${directory}.resolution.json`)).toBe(false);
    expect(existsSync(`${nested}.resolution.json`)).toBe(false);
  });

  it('R14: resolve-corrupt accepts a quarantined regular file and writes the sidecar', async () => {
    const root = await makeRoot();
    const recovery = new ExecutionRecovery(root, dependencies());
    const quarantined = join(root, 'broken.json.corrupt-456');
    await writeFile(quarantined, '{not-json', 'utf8');

    const result = await recovery.resolveCorruptJournal(quarantined, 'operator inspected the file');

    expect(result.resolved).toBe(true);
    expect(existsSync(`${quarantined}.resolution.json`)).toBe(true);
  });

  it('R15: resolve refuses when the guard cannot prove the whole tree gone', async () => {
    const root = await makeRoot();
    const executionId = 'execution_guard_live';
    const guard = guardRecord({ executionId, supervisorPid: 8080 });
    const guardPath = await writeGuard(root, guard);
    const deps = dependencies({
      inspectProcess: vi.fn(async (pid: number) =>
        pid === 8080 ? identity(pid, guard.supervisorStartTime) : null,
      ),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(
      journalRecord({
        executionId,
        pid: guard.supervisorPid,
        processStartTime: guard.supervisorStartTime,
        processKind: 'supervisor',
        launchToken: guard.launchToken,
        guardPath,
      }),
    );
    const finish = vi.spyOn(recovery.journal, 'finish');

    const result = await recovery.resolveBlockedExecution(executionId, 'operator says done');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('Process tree is not proven gone');
    expect(result.reason).toContain('still alive');
    expect(finish).not.toHaveBeenCalled();
    expect((await recovery.journal.read(executionId))?.status).toBe('active');
  });

  it('R15b: resolve treats a guard inspection failure as unproven', async () => {
    const root = await makeRoot();
    const executionId = 'execution_guard_throws';
    const guard = guardRecord({ executionId, supervisorPid: 8083 });
    const guardPath = await writeGuard(root, guard);
    const deps = dependencies({
      inspectProcess: vi.fn(async (pid: number) => {
        if (pid === 8083) throw new Error('injected identity inspection failure');
        return null;
      }),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(
      journalRecord({
        executionId,
        pid: guard.supervisorPid,
        processStartTime: guard.supervisorStartTime,
        processKind: 'supervisor',
        launchToken: guard.launchToken,
        guardPath,
      }),
    );
    const finish = vi.spyOn(recovery.journal, 'finish');

    const result = await recovery.resolveBlockedExecution(executionId, 'operator says done');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('PID identity is not verified');
    expect(finish).not.toHaveBeenCalled();
    expect((await recovery.journal.read(executionId))?.status).toBe('active');
  });

  it('R16: resolve refuses a guard whose identity no longer matches', async () => {
    const root = await makeRoot();
    const executionId = 'execution_guard_mismatch';
    const guard = guardRecord({
      executionId,
      supervisorPid: 8081,
      supervisorStartTime: 'start-recorded',
    });
    const guardPath = await writeGuard(root, guard);
    const deps = dependencies({
      inspectProcess: vi.fn(async (pid: number) =>
        pid === 8081 ? identity(pid, 'start-different') : null,
      ),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(
      journalRecord({
        executionId,
        pid: guard.supervisorPid,
        processStartTime: guard.supervisorStartTime,
        processKind: 'supervisor',
        launchToken: guard.launchToken,
        guardPath,
      }),
    );

    const result = await recovery.resolveBlockedExecution(executionId, 'operator says done');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('PID identity is not verified');
    expect((await recovery.journal.read(executionId))?.status).toBe('active');
  });

  it('R17: resolve refuses a live legacy PID that matches the record', async () => {
    const root = await makeRoot();
    const executionId = 'execution_legacy_live';
    const deps = dependencies({
      inspectProcess: vi.fn(async (pid: number) =>
        pid === 5050 ? identity(pid, 'start-legacy') : null,
      ),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(
      journalRecord({
        executionId,
        pid: 5050,
        processStartTime: 'start-legacy',
      }),
    );
    const finish = vi.spyOn(recovery.journal, 'finish');

    const result = await recovery.resolveBlockedExecution(executionId, 'operator says done');

    expect(result.resolved).toBe(false);
    expect(result.reason).toContain('PID_STILL_ALIVE');
    expect(finish).not.toHaveBeenCalled();
    expect((await recovery.journal.read(executionId))?.status).toBe('active');
  });

  it.skipIf(process.platform === 'win32')(
    'R18: resolve refuses a non-empty protected process group even without a root PID',
    async () => {
      const root = await makeRoot();
      const executionId = 'execution_group_live';
      const self = await inspectProcess(process.pid);
      if (!self?.processGroupId) return;
      const deps = dependencies({
        inspectProcess: vi.fn().mockResolvedValue(null),
      });
      const recovery = new ExecutionRecovery(root, deps);
      await recovery.journal.begin(
        journalRecord({
          executionId,
          pid: null,
          processStartTime: null,
          processGroupId: self.processGroupId,
        }),
      );

      const result = await recovery.resolveBlockedExecution(executionId, 'operator says done');

      expect(result.resolved).toBe(false);
      expect(result.reason).toContain('PROCESS_GROUP_NOT_EMPTY');
      expect((await recovery.journal.read(executionId))?.status).toBe('active');
    },
  );

  it('R19: resolve succeeds only after a readable guard confirms the tree gone', async () => {
    const root = await makeRoot();
    const executionId = 'execution_guard_gone';
    const guard = guardRecord({ executionId, supervisorPid: 8082 });
    const guardPath = await writeGuard(root, guard);
    const recovery = new ExecutionRecovery(root, dependencies());
    await recovery.journal.begin(
      journalRecord({
        executionId,
        pid: guard.supervisorPid,
        processStartTime: guard.supervisorStartTime,
        processKind: 'supervisor',
        launchToken: guard.launchToken,
        guardPath,
      }),
    );

    const result = await recovery.resolveBlockedExecution(executionId, 'operator says done');

    expect(result.resolved).toBe(true);
    expect((await recovery.journal.read(executionId))?.status).toBe('interrupted');
    expect(existsSync(join(root, 'state', 'resolutions', `${executionId}.json`))).toBe(true);
  });
});
