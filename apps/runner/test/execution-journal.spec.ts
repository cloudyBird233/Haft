import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionJournal,
  type ExecutionJournalRecord,
} from '../src/execution-journal';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-journal-'));
  roots.push(root);
  return root;
}

function record(overrides: Partial<ExecutionJournalRecord> = {}): ExecutionJournalRecord {
  return {
    version: 1,
    executionId: 'execution_journal_test',
    runtime: 'codex',
    projectId: 'project_demo',
    pid: 4242,
    processStartTime: 'start-100',
    processGroupId: 4242,
    worktreePath: '/tmp/worktrees/project/execution_journal_test',
    branchName: 'haft/execution_journal_test',
    baseCommit: 'a'.repeat(40),
    phase: 'running',
    status: 'active',
    lastSequence: 4,
    startedAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:00:01.000Z',
    finishedAt: null,
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('ExecutionJournal', () => {
  it('writes and reads the complete recovery record', async () => {
    const root = await makeRoot();
    const journal = new ExecutionJournal(root);
    await journal.begin(record());
    await journal.update(
      'execution_journal_test',
      { phase: 'finalizing', lastSequence: 9, status: 'active' },
      { immediate: true },
    );
    await journal.finish('execution_journal_test', 'completed', 'completed', 10);

    const restored = await new ExecutionJournal(root).read('execution_journal_test');
    expect(restored).toMatchObject({
      executionId: 'execution_journal_test',
      runtime: 'codex',
      pid: 4242,
      processStartTime: 'start-100',
      processGroupId: 4242,
      worktreePath: record().worktreePath,
      branchName: 'haft/execution_journal_test',
      baseCommit: 'a'.repeat(40),
      phase: 'completed',
      status: 'completed',
      lastSequence: 10,
    });
    expect(restored?.finishedAt).toBeTruthy();
  });

  it('leaves a complete record when a crash interrupts an atomic write', async () => {
    const root = await makeRoot();
    const journal = new ExecutionJournal(root);
    await journal.begin(record());
    // A crashed writer leaves only a temporary file; list() must ignore it and
    // keep the last complete record readable.
    await writeFile(join(root, 'execution_journal_test.json.crashed.tmp'), '{"partial":', 'utf8');

    const records = await new ExecutionJournal(root).list();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('active');
    expect(records[0]?.lastSequence).toBe(4);
  });

  it('quarantines a corrupt journal instead of returning invalid state', async () => {
    const root = await makeRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'broken.json'), '{not-json', 'utf8');

    const journal = new ExecutionJournal(root);
    expect(await journal.list()).toEqual([]);
    const files = await readdir(root);
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('prunes terminal records but keeps active journals', async () => {
    const root = await makeRoot();
    const journal = new ExecutionJournal(root);
    await journal.begin(record({ executionId: 'execution_active' }));
    await journal.begin(record({ executionId: 'execution_done' }));
    await journal.finish('execution_done', 'failed', 'failed', 2);

    const removed = await journal.pruneTerminal(-1);
    expect(removed).toBe(1);
    const remaining = await journal.list();
    expect(remaining.map((item) => item.executionId)).toEqual(['execution_active']);
  });
});
