import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerLogEntry } from '@raft-lite/contracts';
import { log } from './logger';

export interface LogSpoolOptions {
  maxEntriesPerExecution?: number;
  maxBytesPerExecution?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Durable, append-only runner log spool.
 *
 * Every log entry is appended before it is sent. The server acknowledges the
 * highest persisted runner sequence; acknowledged entries are removed by an
 * atomic rewrite. On reconnect the spool is the replay source, and duplicate
 * sequences are ignored so a redelivered batch can never inflate the log.
 *
 * The spool is bounded per execution. A very long disconnect keeps the newest
 * entries and drops the oldest tail, matching the in-memory pending buffer.
 */
export class LogSpool {
  private readonly entries = new Map<string, RunnerLogEntry[]>();
  private readonly bytes = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  /** A crashed append can leave a JSON line without its terminating newline. */
  private readonly needsSeparator = new Set<string>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(
    private readonly root: string,
    options: LogSpoolOptions = {},
  ) {
    this.maxEntries = options.maxEntriesPerExecution ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytesPerExecution ?? DEFAULT_MAX_BYTES;
  }

  append(executionId: string, entry: RunnerLogEntry): Promise<void> {
    return this.enqueue(executionId, async () => {
      const current = await this.load(executionId);
      if (current.some((item) => item.sequence === entry.sequence)) {
        return;
      }
      const line = serialize(entry);
      await mkdir(this.root, { recursive: true });
      if (this.needsSeparator.delete(executionId)) {
        // Terminate the invalid partial record first; otherwise the next entry
        // would be appended to it and both lines would be unparseable.
        await appendFile(this.fileFor(executionId), '\n', 'utf8');
        this.bytes.set(executionId, (this.bytes.get(executionId) ?? 0) + 1);
      }
      await appendFile(this.fileFor(executionId), line, 'utf8');
      current.push(entry);
      current.sort((left, right) => left.sequence - right.sequence);
      this.entries.set(executionId, current);
      this.bytes.set(executionId, (this.bytes.get(executionId) ?? 0) + Buffer.byteLength(line));
      await this.trim(executionId, current);
    }).catch((error: unknown) => {
      log('warn', {
        eventType: 'runner.log_spool_failed',
        message: 'Could not append a runner log to the durable spool',
        status: 'warning',
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async read(executionId: string, limit?: number): Promise<RunnerLogEntry[]> {
    await this.queues.get(executionId);
    const current = await this.load(executionId);
    const sorted = [...current].sort((left, right) => left.sequence - right.sequence);
    return typeof limit === 'number' && limit >= 0 ? sorted.slice(-limit) : sorted;
  }

  /**
   * Removes every entry with `sequence <= throughSeq`. Returns the number of
   * removed entries. An empty spool file is deleted.
   */
  async acknowledge(executionId: string, throughSeq: number): Promise<number> {
    let removed = 0;
    await this.enqueue(executionId, async () => {
      const current = await this.load(executionId);
      const remaining = current.filter((entry) => entry.sequence > throughSeq);
      removed = current.length - remaining.length;
      if (removed === 0) return;
      this.entries.set(executionId, remaining);
      this.bytes.set(
        executionId,
        remaining.reduce((total, entry) => total + Buffer.byteLength(serialize(entry)), 0),
      );
      if (remaining.length === 0) {
        this.bytes.set(executionId, 0);
        this.needsSeparator.delete(executionId);
        await rm(this.fileFor(executionId), { force: true }).catch(() => undefined);
        return;
      }
      await this.rewrite(executionId, remaining);
    });
    return removed;
  }

  async count(executionId: string): Promise<number> {
    await this.queues.get(executionId);
    return (await this.load(executionId)).length;
  }

  async totalCount(): Promise<number> {
    let total = 0;
    for (const executionId of await this.listExecutionIds()) {
      total += await this.count(executionId);
    }
    return total;
  }

  async listExecutionIds(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'))
      .map((entry) => entry.name.slice(0, -'.ndjson'.length))
      .sort();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private async load(executionId: string): Promise<RunnerLogEntry[]> {
    const cached = this.entries.get(executionId);
    if (cached) return cached;

    let raw = '';
    try {
      raw = await readFile(this.fileFor(executionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (raw.length > 0 && !raw.endsWith('\n')) {
      this.needsSeparator.add(executionId);
    } else {
      this.needsSeparator.delete(executionId);
    }

    const bySequence = new Map<number, RunnerLogEntry>();
    let byteSize = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as RunnerLogEntry;
        if (
          !parsed ||
          typeof parsed.sequence !== 'number' ||
          typeof parsed.message !== 'string'
        ) {
          continue;
        }
        byteSize += Buffer.byteLength(line) + 1;
        bySequence.set(parsed.sequence, parsed);
      } catch {
        // A crash can leave a partial final line. Earlier complete records are
        // still valid and must remain replayable.
      }
    }
    const loaded = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
    this.entries.set(executionId, loaded);
    this.bytes.set(executionId, byteSize);
    return loaded;
  }

  private async trim(executionId: string, current: RunnerLogEntry[]): Promise<void> {
    let bytes = this.bytes.get(executionId) ?? 0;
    let start = 0;
    while (
      current.length - start > this.maxEntries ||
      (bytes > this.maxBytes && current.length - start > 1)
    ) {
      bytes -= Buffer.byteLength(serialize(current[start] as RunnerLogEntry));
      start += 1;
    }
    if (start === 0) return;
    const kept = current.slice(start);
    this.entries.set(executionId, kept);
    this.bytes.set(executionId, bytes);
    await this.rewrite(executionId, kept);
  }

  private async rewrite(executionId: string, entries: RunnerLogEntry[]): Promise<void> {
    this.needsSeparator.delete(executionId);
    if (entries.length === 0) {
      this.entries.set(executionId, []);
      this.bytes.set(executionId, 0);
      await rm(this.fileFor(executionId), { force: true }).catch(() => undefined);
      return;
    }
    await mkdir(this.root, { recursive: true });
    const target = this.fileFor(executionId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const content = entries.map((entry) => serialize(entry)).join('');
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private enqueue(executionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(executionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(executionId, run.then(() => undefined, () => undefined));
    return run;
  }

  private fileFor(executionId: string): string {
    return join(this.root, `${sanitize(executionId)}.ndjson`);
  }
}

function serialize(entry: RunnerLogEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return sanitized || 'execution';
}
