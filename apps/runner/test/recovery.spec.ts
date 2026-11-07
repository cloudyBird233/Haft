import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
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

    const [report] = await recovery.scan();
    expect(report).toMatchObject({
      processAlive: false,
      pidReused: false,
      ownershipMismatch: false,
      orphanTerminated: false,
      orphanStillAlive: false,
    });
    expect(report?.logs.map((entry) => entry.sequence)).toEqual([1]);
    expect(report?.summary).toContain('no surviving CLI process');
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect((await recovery.journal.read(value.executionId))?.status).toBe('interrupted');
    // The archived worktree and spool are evidence; recovery must not delete them.
    expect((await stat(worktree)).isDirectory()).toBe(true);
    expect((await recovery.readLogs(value.executionId)).length).toBe(1);
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

    const [report] = await recovery.scan();
    expect(deps.terminateProcessTree).toHaveBeenCalledWith(4242);
    expect(deps.waitForProcessExit).toHaveBeenCalled();
    expect(report).toMatchObject({
      processAlive: true,
      orphanTerminated: true,
      orphanStillAlive: false,
    });
    expect(report?.summary).toContain('orphaned CLI process tree was terminated');
  });

  it('never kills a PID that was reused by another process', async () => {
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

    const [report] = await recovery.scan();
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({ pidReused: true, orphanTerminated: false });
    expect(report?.summary).toContain('different process');
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

    const [report] = await recovery.scan();
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({ ownershipMismatch: true });
    expect(report?.summary).toContain('does not belong to this execution');
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

    const [report] = await recovery.scan();
    expect(deps.terminateProcessTree).not.toHaveBeenCalled();
    expect(report).toMatchObject({ processIdentityUnverified: true });
    expect(report?.summary).toContain('could not be verified');
  });

  it('ignores terminal journals so a completed execution is never replayed', async () => {
    const root = await makeRoot();
    const deps = dependencies();
    const recovery = new ExecutionRecovery(root, deps);
    await recovery.journal.begin(record({ status: 'completed', phase: 'completed' }));

    expect(await recovery.scan()).toEqual([]);
    expect(deps.inspectProcess).not.toHaveBeenCalled();
  });
});
