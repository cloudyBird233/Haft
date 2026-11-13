import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionJournalRecord } from '../src/execution-journal';
import { ExecutionRecovery, type RecoveryDependencies } from '../src/recovery';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-journal-pid-schema-'));
  roots.push(root);
  return root;
}

function journalRecord(overrides: Partial<ExecutionJournalRecord> = {}): ExecutionJournalRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    executionId: 'execution_pid_schema',
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

function dependencies(): RecoveryDependencies {
  return {
    inspectProcess: vi.fn().mockResolvedValue(null),
    terminateProcessTree: vi.fn().mockResolvedValue(undefined),
    waitForProcessExit: vi.fn().mockResolvedValue(true),
  };
}

async function writeRawJournal(
  root: string,
  record: Record<string, unknown>,
  name = 'execution_invalid.json',
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

const invalidPidCases: Array<[string, (record: Record<string, unknown>) => void]> = [
  ['a numeric string PID', (record) => (record.pid = '1234')],
  ['a zero PID', (record) => (record.pid = 0)],
  ['a negative PID', (record) => (record.pid = -10)],
  ['a fractional PID', (record) => (record.pid = 12.5)],
  ['an unsafe integer PID', (record) => (record.pid = Number.MAX_SAFE_INTEGER + 2)],
  ['a boolean PID', (record) => (record.pid = true)],
  ['a missing PID field', (record) => delete record.pid],
  ['a missing process start time', (record) => delete record.processStartTime],
  ['a non-string process start time', (record) => (record.processStartTime = 1234)],
  [
    'a numeric-string supervisor PID',
    (record) => {
      record.processKind = null;
      record.supervisorPid = 'not-a-number';
    },
  ],
  [
    'a zero supervisor PID',
    (record) => {
      record.processKind = null;
      record.supervisorPid = 0;
    },
  ],
  [
    'a numeric-string CLI PID',
    (record) => {
      record.processKind = null;
      record.cliPid = 'not-a-number';
    },
  ],
  [
    'a zero CLI PID',
    (record) => {
      record.processKind = null;
      record.cliPid = 0;
    },
  ],
  ['a numeric-string process group ID', (record) => (record.processGroupId = 'not-a-number')],
  ['a zero process group ID', (record) => (record.processGroupId = 0)],
  ['a negative process group ID', (record) => (record.processGroupId = -1)],
  ['a fractional process group ID', (record) => (record.processGroupId = 42.5)],
  ['a missing process group ID', (record) => delete record.processGroupId],
  [
    'a missing required supervisor PID',
    (record) => {
      record.pid = 1234;
      record.processStartTime = 'start-1234';
      record.processKind = 'supervisor';
      record.spawnState = 'supervisor-ready';
      record.supervisorPid = null;
      record.supervisorStartTime = 'start-supervisor';
    },
  ],
  [
    'inconsistent supervisor and root PIDs',
    (record) => {
      record.pid = 1234;
      record.processStartTime = 'start-1234';
      record.processKind = 'supervisor';
      record.spawnState = 'supervisor-ready';
      record.supervisorPid = 5678;
      record.supervisorStartTime = 'start-supervisor';
    },
  ],
  [
    'a supervisor-ready record without a root PID',
    (record) => {
      record.pid = null;
      record.processKind = 'supervisor';
      record.spawnState = 'supervisor-ready';
      record.supervisorPid = 1234;
      record.supervisorStartTime = 'start-supervisor';
    },
  ],
  [
    'a running record without a supervisor start time',
    (record) => {
      record.pid = 1234;
      record.processStartTime = 'start-1234';
      record.processKind = 'supervisor';
      record.spawnState = 'running';
      record.supervisorPid = 1234;
      record.supervisorStartTime = null;
    },
  ],
  [
    'a CLI PID equal to the recorded root PID',
    (record) => {
      record.pid = 1234;
      record.processStartTime = 'start-1234';
      record.processKind = null;
      record.cliPid = 1234;
    },
  ],
  [
    'a direct record with a supervisor identity',
    (record) => {
      record.processKind = 'direct';
      record.supervisorPid = 1234;
    },
  ],
  [
    'a direct record with a CLI identity',
    (record) => {
      record.processKind = 'direct';
      record.cliPid = 1234;
    },
  ],
  [
    'a direct record that claims supervisor readiness',
    (record) => {
      record.processKind = 'direct';
      record.spawnState = 'supervisor-ready';
    },
  ],
  [
    'a running record without a PID',
    (record) => {
      record.pid = null;
      record.processStartTime = null;
      record.processKind = 'direct';
      record.spawnState = 'running';
    },
  ],
  [
    'a non-supervisor record that claims supervisor readiness',
    (record) => {
      record.pid = 1234;
      record.processStartTime = 'start-1234';
      record.processKind = null;
      record.spawnState = 'supervisor-ready';
      record.supervisorPid = 1234;
      record.supervisorStartTime = 'start-supervisor';
    },
  ],
];

describe('Journal process identity schema (P2-2C)', () => {
  for (const [description, mutate] of invalidPidCases) {
    it(`quarantines a journal with ${description} instead of finalizing it`, async () => {
      const root = await makeRoot();
      const record = { ...journalRecord() } as Record<string, unknown>;
      mutate(record);
      const journalPath = await writeRawJournal(root, record);

      const scan = await new ExecutionRecovery(root, dependencies()).scan();

      expect(scan.clean).toBe(false);
      expect(scan.corrupted).toHaveLength(1);
      expect(scan.executions).toEqual([]);
      expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
      expect(existsSync(journalPath)).toBe(false);
      const quarantined = scan.corrupted[0]?.quarantinedPath;
      expect(quarantined).toBeTruthy();
      const evidence = JSON.parse(await readFile(quarantined as string, 'utf8')) as {
        status?: string;
      };
      expect(evidence.status).toBe('active');
    });
  }

  it('IR8: a non-numeric PID is never finalized as interrupted', async () => {
    const root = await makeRoot();
    const record = {
      ...journalRecord({ pid: 'not-a-number' as unknown as number }),
    } as Record<string, unknown>;
    const journalPath = await writeRawJournal(root, record);

    const scan = await new ExecutionRecovery(root, dependencies()).scan();

    expect(scan.clean).toBe(false);
    expect(scan.executions).toEqual([]);
    expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
    expect(existsSync(journalPath)).toBe(false);
    const evidence = JSON.parse(
      await readFile(scan.corrupted[0]?.quarantinedPath as string, 'utf8'),
    ) as { status?: string };
    expect(evidence.status).toBe('active');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a JSON string', '"not-a-journal"'],
  ])('quarantines %s JSON without crashing the scan', async (_label, contents) => {
    const root = await makeRoot();
    const journalPath = join(root, 'execution_non_object.json');
    await writeFile(journalPath, contents, 'utf8');

    const scan = await new ExecutionRecovery(root, dependencies()).scan();

    expect(scan.clean).toBe(false);
    expect(scan.corrupted).toHaveLength(1);
    expect(scan.blocked.some((entry) => entry.kind === 'corrupt-journal')).toBe(true);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('accepts legal historical records without the newer optional identity fields', async () => {
    const root = await makeRoot();
    const record = { ...journalRecord() } as Record<string, unknown>;
    record.executionId = 'execution_historical';
    record.pid = 4242;
    record.processStartTime = 'start-4242';
    record.processGroupId = null;
    delete record.launchToken;
    delete record.guardPath;
    delete record.supervisorPid;
    delete record.supervisorStartTime;
    delete record.cliPid;
    delete record.cliStartTime;
    delete record.processKind;
    delete record.spawnState;
    await writeRawJournal(root, record, 'execution_historical.json');

    const scan = await new ExecutionRecovery(root, dependencies()).scan();

    expect(scan.corrupted).toEqual([]);
    expect(scan.blocked).toEqual([]);
    expect(scan.clean).toBe(true);
    const finalized = JSON.parse(
      await readFile(join(root, 'execution_historical.json'), 'utf8'),
    ) as { status?: string };
    expect(finalized.status).toBe('interrupted');
  });

  it('accepts a legal active record with a null PID and blocks instead of quarantining', async () => {
    const root = await makeRoot();
    await writeRawJournal(
      root,
      { ...journalRecord({ executionId: 'execution_null_pid' }) } as Record<string, unknown>,
      'execution_null_pid.json',
    );

    const scan = await new ExecutionRecovery(root, dependencies()).scan();

    expect(scan.corrupted).toEqual([]);
    expect(scan.clean).toBe(false);
    expect(scan.executions[0]?.blockedReason).toContain('PID_NOT_RECORDED');
    expect(JSON.parse(await readFile(join(root, 'execution_null_pid.json'), 'utf8')).status).toBe(
      'active',
    );
  });
});
