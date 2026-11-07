import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerLogEntry } from '@raft-lite/contracts';
import { LogSpool } from '../src/log-spool';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-spool-'));
  roots.push(root);
  return root;
}

function entry(sequence: number, message = `log ${sequence}`): RunnerLogEntry {
  return {
    sequence,
    eventId: `event-${sequence}`,
    stream: 'stdout',
    level: 'info',
    message,
    timestamp: '2026-11-07T10:00:00.000Z',
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('LogSpool', () => {
  it('persists entries in sequence order and ignores duplicate sequences', async () => {
    const root = await makeRoot();
    const spool = new LogSpool(root);
    await spool.append('execution_logs', entry(2));
    await spool.append('execution_logs', entry(1));
    await spool.append('execution_logs', entry(2, 'duplicate must be ignored'));

    const restored = await new LogSpool(root).read('execution_logs');
    expect(restored.map((item) => item.sequence)).toEqual([1, 2]);
    expect(restored[1]?.message).toBe('log 2');
  });

  it('removes acknowledged entries and deletes an empty spool file', async () => {
    const root = await makeRoot();
    const spool = new LogSpool(root);
    for (const sequence of [1, 2, 3, 4]) {
      await spool.append('execution_logs', entry(sequence));
    }

    expect(await spool.acknowledge('execution_logs', 2)).toBe(2);
    expect((await spool.read('execution_logs')).map((item) => item.sequence)).toEqual([3, 4]);
    expect(await spool.acknowledge('execution_logs', 4)).toBe(2);
    expect(await spool.read('execution_logs')).toEqual([]);
    expect(await spool.listExecutionIds()).toEqual([]);
  });

  it('recovers complete entries after a crash leaves a partial final line', async () => {
    const root = await makeRoot();
    const spool = new LogSpool(root);
    await spool.append('execution_logs', entry(1));
    await spool.append('execution_logs', entry(2));
    await appendFile(join(root, 'execution_logs.ndjson'), '{"sequence":3,"mess', 'utf8');

    const restored = await new LogSpool(root).read('execution_logs');
    expect(restored.map((item) => item.sequence)).toEqual([1, 2]);
    const raw = await readFile(join(root, 'execution_logs.ndjson'), 'utf8');
    expect(raw).toContain('"sequence":1');
  });

  it('repairs a partial final line before appending a new entry', async () => {
    const root = await makeRoot();
    const spool = new LogSpool(root);
    await spool.append('execution_logs', entry(1));
    await spool.append('execution_logs', entry(2));
    await appendFile(join(root, 'execution_logs.ndjson'), '{"sequence":3,"mess', 'utf8');

    const reopened = new LogSpool(root);
    await reopened.append('execution_logs', entry(4, 'written after the crash'));

    const restored = await new LogSpool(root).read('execution_logs');
    expect(restored.map((item) => item.sequence)).toEqual([1, 2, 4]);
    expect(restored[2]?.message).toBe('written after the crash');
  });

  it('enforces the per-execution entry limit by keeping the newest entries', async () => {
    const root = await makeRoot();
    const spool = new LogSpool(root, { maxEntriesPerExecution: 3 });
    for (const sequence of [1, 2, 3, 4, 5]) {
      await spool.append('execution_logs', entry(sequence));
    }

    const restored = await new LogSpool(root, { maxEntriesPerExecution: 3 }).read(
      'execution_logs',
    );
    expect(restored.map((item) => item.sequence)).toEqual([3, 4, 5]);
  });

  it('limits replayed entries without losing the newest tail', async () => {
    const root = await makeRoot();
    const spool = new LogSpool(root);
    for (const sequence of [1, 2, 3, 4]) {
      await spool.append('execution_logs', entry(sequence));
    }

    expect((await spool.read('execution_logs', 2)).map((item) => item.sequence)).toEqual([
      3, 4,
    ]);
  });
});
