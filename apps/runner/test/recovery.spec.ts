import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerLogEntry } from '@raft-lite/contracts';
import type { ExecutionJournalRecord } from '../src/execution-journal';
import { ExecutionRecovery, type RecoveryDependencies } from '../src/recovery';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-recovery-'));
  roots.push(root);
  return root;
}

function record(overrides: Partial<ExecutionJournalRecord> = {}): ExecutionJournalRecord {
  return {
    version: 1,
    executionId: 'execution_recovery',
    runtime: 'codex',
    projectId: 'project_demo',
    pid: 4242,
    processStartTime: 'start-100',
    processGroupId: 4242,
    worktreePath: '/tmp/worktrees/project/execution_recovery',
    branchName: 'haft/execution_recovery',
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

function logEntry(sequence: number): RunnerLogEntry {
  return {
    sequence,
    eventId: `event-${sequence}`,
    stream: 'stdout',
    level: 'info',
    message: `recovered log ${sequence}`,
    timestamp: '2026-11-07T10:00:00.000Z',
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

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('ExecutionRecovery', () => {
  it('reports an interrupted execution and preserves its worktree and logs', async () => {
    const root = await makeRoot();
    const worktree = join(root, 'worktree-preserved');
    await mkdir(worktree, { recursive: true });
    const deps = dependencies();
    const recovery = new ExecutionRecovery(root, deps);
    const value = record({ worktreePath: worktree });
    await recovery.journal.begin(value);
    await recovery.appendLog(value.executionId, logEntry(1));
    await recovery.spool.flush();

    const scan = await recovery.scan();
    expect(scan.clean).toBe(true);
    const report = scan.executions[0];
    expect(report).toMatchObject({
      processAlive: false,
      pidReused: false,
      ownershipMismatch: false,
      orphanTerminated: false,
      orphanStillAlive: false,
      worktreeExists: true,
      journalFinalized: true,
    });
    expect(report?.logs.map((entry) => entry.sequence)).toEqual([1]);
    expect(report?.summary).toContain('no surviving protected CLI process');
    expect(report?.summary).toContain('worktree preserved');
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect((await recovery.journal.read(value.executionId))?.status).toBe('interrupted');
    // The archived worktree and spool are evidence; recovery must not delete them.
    expect((await stat(worktree)).isDirectory()).toBe(true);
    expect((await recovery.readLogs(value.executionId)).length).toBe(1);
  });

  it('reports a worktree that no longer exists and still marks the journal interrupted', async () => {
    const root = await makeRoot();
    const missingWorktree = join(root, 'worktree-already-gone');
    const deps = dependencies();
    const recovery = new ExecutionRecovery(root, deps);
    const value = record({ worktreePath: missingWorktree });
    await recovery.journal.begin(value);
    await recovery.appendLog(value.executionId, logEntry(1));
    await recovery.spool.flush();

    const report = (await recovery.scan()).executions[0];
    expect(report).toMatchObject({ worktreeExists: false, journalFinalized: true });
    expect(report?.summary).toContain('could not be found');
    expect((await recovery.journal.read(value.executionId))?.status).toBe('interrupted');
    expect(await recovery.readLogs(value.executionId)).toHaveLength(1);
  });

  it('verifies PID start time and ownership before terminating an orphan', async () => {
    const root = await makeRoot();
    const deps = dependencies({
      inspectProcess: vi.fn().mockResolvedValue({
        pid: 4242,
        parentPid: 1,
        processGroupId: 4242,
        startTime: 'start-100',
        commandLine: 'codex exec -C /tmp/worktrees/project/execution_recovery -',
      }),
      waitForProcessExit: vi.fn().mockResolvedValue(true),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(record());

    const report = (await recovery.scan()).executions[0];
    expect(deps.terminateProcessTree).toHaveBeenCalledWith(4242);
    expect(deps.waitForProcessExit).toHaveBeenCalled();
    expect(report).toMatchObject({
      processAlive: true,
      orphanTerminated: true,
      orphanStillAlive: false,
      treeConfirmedGone: true,
      journalFinalized: true,
    });
    expect(report?.summary).toContain('orphaned protected process tree was terminated');
  });

  it('never kills a PID that was reused by another process and blocks recovery', async () => {
    const root = await makeRoot();
    const deps = dependencies({
      inspectProcess: vi.fn().mockResolvedValue({
        pid: 4242,
        parentPid: 1,
        processGroupId: 4242,
        startTime: 'start-999',
        commandLine: 'codex exec -C /tmp/worktrees/project/execution_recovery -',
      }),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(record());

    const scan = await recovery.scan();
    const report = scan.executions[0];
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      pidReused: true,
      orphanTerminated: false,
      journalFinalized: false,
      recoveryBlocked: true,
    });
    expect(report?.summary).toContain('different process');
    expect(scan.clean).toBe(false);
    expect(scan.blocked[0]?.reason).toContain('PID_REUSED');
    // The journal stays active as recovery evidence.
    expect((await recovery.journal.read('execution_recovery'))?.status).toBe('active');
  });

  it('never kills a process whose identity or ownership does not match', async () => {
    const root = await makeRoot();
    const deps = dependencies({
      inspectProcess: vi.fn().mockResolvedValue({
        pid: 4242,
        parentPid: 1,
        processGroupId: 9999,
        startTime: 'start-100',
        commandLine: 'unrelated-service.exe --port 3000',
      }),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(record());

    const scan = await recovery.scan();
    const report = scan.executions[0];
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({ ownershipMismatch: true, recoveryBlocked: true });
    expect(report?.summary).toContain('does not belong to this execution');
    expect((await recovery.journal.read('execution_recovery'))?.status).toBe('active');
  });

  it('leaves a process untouched when no start time was recorded', async () => {
    const root = await makeRoot();
    const deps = dependencies({
      inspectProcess: vi.fn().mockResolvedValue({
        pid: 4242,
        parentPid: 1,
        processGroupId: 4242,
        startTime: 'start-100',
        commandLine: 'codex exec',
      }),
    });
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(record({ processStartTime: null }));

    const scan = await recovery.scan();
    const report = scan.executions[0];
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      processIdentityUnverified: true,
      recoveryBlocked: true,
      journalFinalized: false,
    });
    expect(report?.summary).toContain('PID_IDENTITY_UNVERIFIED');
    expect((await recovery.journal.read('execution_recovery'))?.status).toBe('active');
  });

  it('blocks recovery for an active journal without a PID', async () => {
    const root = await makeRoot();
    const deps = dependencies();
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(
      record({ pid: null, processStartTime: null, processGroupId: null }),
    );

    const scan = await recovery.scan();
    const report = scan.executions[0];
    expect(deps.inspectProcess).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      journalFinalized: false,
      recoveryBlocked: true,
      treeConfirmedGone: false,
    });
    expect(report?.summary).toContain('PID_NOT_RECORDED');
    expect(scan.blocked[0]?.kind).toBe('journal');
    expect((await recovery.journal.read('execution_recovery'))?.status).toBe('active');
  });

  it('blocks recovery for a supervisor journal whose guard is missing', async () => {
    const root = await makeRoot();
    const recovery = new ExecutionRecovery(root, dependencies());
    await recovery.journal.begin(
      record({
        pid: null,
        processStartTime: null,
        processGroupId: null,
        processKind: 'supervisor',
        launchToken: 'token-1',
        guardPath: join(root, 'guards', 'execution_recovery.token-1.guard.json'),
      }),
    );

    const scan = await recovery.scan();
    const report = scan.executions[0];
    expect(report).toMatchObject({ recoveryBlocked: true, journalFinalized: false });
    expect(report?.summary).toContain('SUPERVISOR_GUARD_MISSING');
    expect((await recovery.journal.read('execution_recovery'))?.status).toBe('active');
  });

  it('keeps corrupt journals as evidence and exposes the corruption', async () => {
    const root = await makeRoot();
    const recovery = new ExecutionRecovery(root, dependencies());
    await writeFile(join(root, 'broken.json'), '{not-json', 'utf8');

    const scan = await recovery.scan();
    expect(scan.executions).toEqual([]);
    expect(scan.corrupted).toHaveLength(1);
    expect(scan.clean).toBe(false);
    expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
    const files = await readdir(root);
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('ignores terminal journals so a completed execution is never replayed', async () => {
    const root = await makeRoot();
    const deps = dependencies();
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(record({ status: 'completed', phase: 'completed' }));

    expect((await recovery.scan()).executions).toEqual([]);
    expect(deps.inspectProcess).not.toHaveBeenCalled();
  });
});
