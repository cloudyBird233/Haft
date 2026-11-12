import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionJournal, type ExecutionJournalRecord } from '../src/execution-journal';

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

  it('rejects a failed atomic begin and leaves no durable or cached record', async () => {
    const root = await makeRoot();
    const journal = new ExecutionJournal(root, {
      atomicWrite: async () => {
        throw new Error('journal disk full');
      },
    });

    await expect(journal.begin(record())).rejects.toThrow('journal disk full');
    expect(await journal.read('execution_journal_test')).toBeNull();
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  it('rejects a failed terminal write instead of claiming completion', async () => {
    const root = await makeRoot();
    let failTerminalWrite = false;
    const journal = new ExecutionJournal(root, {
      atomicWrite: async (target, contents) => {
        if (failTerminalWrite) throw new Error('terminal journal write failed');
        await writeFile(target, contents, 'utf8');
      },
    });
    await journal.begin(record());
    failTerminalWrite = true;

    await expect(
      journal.finish('execution_journal_test', 'completed', 'completed', 10),
    ).rejects.toThrow('terminal journal write failed');

    // The previous active record is still the durable truth on disk.
    const restored = await new ExecutionJournal(root).read('execution_journal_test');
    expect(restored?.status).toBe('active');
    expect(restored?.finishedAt).toBeNull();
  });

  it('reports a rejected debounced write instead of swallowing it', async () => {
    const root = await makeRoot();
    const errors: unknown[] = [];
    let failWrites = false;
    const journal = new ExecutionJournal(root, {
      atomicWrite: async (target, contents) => {
        if (failWrites) throw new Error('debounced journal write failed');
        await writeFile(target, contents, 'utf8');
      },
      onBackgroundError: (_executionId, error) => {
        errors.push(error);
      },
    });
    await journal.begin(record());
    failWrites = true;

    journal.touch('execution_journal_test', 9);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toContain('debounced journal write failed');
  });

  it('prunes terminal records but keeps active journals', async () => {
    const root = await makeRoot();
    const journal = new ExecutionJournal(root);
    await journal.begin(record({ executionId: 'execution_active' }));
    await journal.begin(record({ executionId: 'execution_done' }));
    await journal.finish('execution_done', 'failed', 'failed', 2);

    // Pin the terminal journal's mtime into the past instead of relying on
    // `Date.now()` ordering. Windows filesystems can round a freshly written
    // file's timestamp past a cutoff computed milliseconds later, which made
    // this test intermittently prune nothing.
    const finished = new Date(Date.now() - 60_000);
    await utimes(join(root, 'execution_done.json'), finished, finished);

    const removed = await journal.pruneTerminal(30_000);
    expect(removed).toBe(1);
    const remaining = await journal.list();
    expect(remaining.map((item) => item.executionId)).toEqual(['execution_active']);
  });
});
