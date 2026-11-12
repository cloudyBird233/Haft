import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionPhase, RunnerRuntimeType } from '@raft-lite/contracts';

export type ExecutionJournalStatus =
  'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * Durable description of one in-flight execution.
 *
 * The file is written before the CLI is spawned and updated while it runs. On
 * startup the runner scans these records, verifies any recorded PID against its
 * start time, and reports the interruption to the server. It never uses the
 * journal to start a replacement execution.
 */
export interface ExecutionJournalRecord {
  version: 1;
  executionId: string;
  runtime: RunnerRuntimeType;
  projectId: string | null;
  pid: number | null;
  processStartTime: string | null;
  processGroupId: number | null;
  worktreePath: string | null;
  branchName: string | null;
  baseCommit: string | null;
  phase: ExecutionPhase;
  status: ExecutionJournalStatus;
  lastSequence: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type ExecutionJournalPatch = Partial<
  Pick<
    ExecutionJournalRecord,
    | 'pid'
    | 'processStartTime'
    | 'processGroupId'
    | 'worktreePath'
    | 'branchName'
    | 'baseCommit'
    | 'phase'
    | 'status'
    | 'lastSequence'
    | 'finishedAt'
  >
>;

const UPDATE_DEBOUNCE_MS = 100;
const STATUS_VALUES: ExecutionJournalStatus[] = [
  'active',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export interface ExecutionJournalOptions {
  /**
   * Test seam for the atomic write. Production uses the default temporary-file
   * plus rename implementation. A rejected promise is a hard journal failure;
   * callers must fail closed.
   */
  atomicWrite?: (target: string, contents: string) => Promise<void>;
  /** Reports a rejected debounced write that no caller is awaiting. */
  onBackgroundError?: (executionId: string, error: unknown) => void;
  /** Reports a journal file that could not be parsed or validated. */
  onCorruptJournal?: (file: string, error: unknown) => void;
}

/**
 * Atomic per-execution journal.
 *
 * Writes go to a temporary file in the same directory and are renamed over the
 * target. A crash therefore leaves either the previous complete record or the
 * new complete record, never a half-written JSON document. Non-critical
 * `touch` updates are coalesced; phases, PID identity and terminal status are
 * written immediately.
 *
 * Every public mutation has explicit success/failure semantics. Callers that
 * cannot tolerate a missing journal must not treat a rejected write as a
 * successful no-op.
 */
export class ExecutionJournal {
  private readonly records = new Map<string, ExecutionJournalRecord>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, ExecutionJournalPatch>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly atomicWrite: (target: string, contents: string) => Promise<void>;
  private backgroundErrorHandler: ((executionId: string, error: unknown) => void) | null;

  constructor(
    private readonly root: string,
    private readonly options: ExecutionJournalOptions = {},
  ) {
    this.atomicWrite = options.atomicWrite ?? defaultAtomicWrite;
    this.backgroundErrorHandler = options.onBackgroundError ?? null;
  }

  /**
   * Registers the process-wide handler for debounced write failures. The
   * executor uses this to terminate a running CLI when its recovery evidence
   * can no longer be persisted.
   */
  setBackgroundErrorHandler(handler: ((executionId: string, error: unknown) => void) | null): void {
    this.backgroundErrorHandler = handler;
  }

  async begin(record: ExecutionJournalRecord): Promise<void> {
    this.records.set(record.executionId, { ...record });
    this.pending.delete(record.executionId);
    try {
      await this.enqueue(record.executionId, () => this.writeNow(record.executionId));
    } catch (error) {
      // Never leave an in-memory record that was never durable. Otherwise a
      // later update could silently resurrect a journal the runner already
      // reported as failed.
      this.records.delete(record.executionId);
      this.pending.delete(record.executionId);
      throw error;
    }
  }

  update(
    executionId: string,
    patch: ExecutionJournalPatch,
    options: { immediate?: boolean } = {},
  ): Promise<void> {
    const current = this.records.get(executionId);
    if (!current) {
      return Promise.reject(
        new Error(`Execution journal record ${executionId} does not exist; refusing to update it`),
      );
    }
    this.pending.set(executionId, { ...(this.pending.get(executionId) ?? {}), ...patch });
    if (options.immediate) {
      return this.flush(executionId);
    }
    if (!this.timers.has(executionId)) {
      const timer = setTimeout(() => {
        this.timers.delete(executionId);
        this.flush(executionId).catch((error: unknown) => {
          this.reportBackgroundError(executionId, error);
        });
      }, UPDATE_DEBOUNCE_MS);
      timer.unref?.();
      this.timers.set(executionId, timer);
    }
    return Promise.resolve();
  }

  touch(executionId: string, lastSequence: number, phase?: ExecutionPhase): void {
    if (!this.records.has(executionId)) return;
    void this.update(executionId, {
      lastSequence,
      ...(phase ? { phase } : {}),
    }).catch((error: unknown) => {
      this.reportBackgroundError(executionId, error);
    });
  }

  async finish(
    executionId: string,
    status: ExecutionJournalStatus,
    phase: ExecutionPhase,
    lastSequence: number,
  ): Promise<ExecutionJournalRecord> {
    await this.flush(executionId);
    const current = this.records.get(executionId);
    if (!current) {
      throw new Error(
        `Execution journal record ${executionId} does not exist; refusing to mark it ${status}`,
      );
    }
    const next: ExecutionJournalRecord = {
      ...current,
      status,
      phase,
      lastSequence,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(executionId, next);
    await this.enqueue(executionId, () => this.writeNow(executionId));
    return next;
  }

  async flush(executionId?: string): Promise<void> {
    const ids = executionId ? [executionId] : [...this.pending.keys()];
    for (const id of ids) {
      const timer = this.timers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
      const patch = this.pending.get(id);
      if (!patch) continue;
      this.pending.delete(id);
      const current = this.records.get(id);
      if (!current) continue;
      this.records.set(id, {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await this.enqueue(id, () => this.writeNow(id));
    }
  }

  async flushAll(): Promise<void> {
    await this.flush();
    await Promise.all([...this.queues.values()]);
  }

  async read(executionId: string): Promise<ExecutionJournalRecord | null> {
    await this.flush(executionId);
    await this.queues.get(executionId);
    const cached = this.records.get(executionId);
    if (cached) return { ...cached };
    const file = this.fileFor(executionId);
    const record = await this.readFile(file);
    if (!record) return null;
    this.records.set(record.executionId, record);
    return { ...record };
  }

  async list(): Promise<ExecutionJournalRecord[]> {
    await this.flushAll();
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: ExecutionJournalRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const record = await this.readFile(join(this.root, entry.name));
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async remove(executionId: string): Promise<void> {
    this.records.delete(executionId);
    this.pending.delete(executionId);
    const timer = this.timers.get(executionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(executionId);
    }
    await this.queues.get(executionId);
    await rm(this.fileFor(executionId), { force: true });
  }

  /** Drops terminal journal files older than the retention window. */
  async pruneTerminal(retentionMs: number): Promise<number> {
    const cutoff = Date.now() - retentionMs;
    let removed = 0;
    for (const record of await this.list()) {
      if (record.status === 'active') continue;
      const file = this.fileFor(record.executionId);
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) {
          await rm(file, { force: true });
          this.records.delete(record.executionId);
          removed += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  private async readFile(file: string): Promise<ExecutionJournalRecord | null> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: Partial<ExecutionJournalRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<ExecutionJournalRecord>;
    } catch (error) {
      this.options.onCorruptJournal?.(file, error);
      await this.quarantine(file);
      return null;
    }
    if (!isValidRecord(parsed)) {
      const error = new Error('Execution journal failed validation');
      this.options.onCorruptJournal?.(file, error);
      await this.quarantine(file);
      return null;
    }
    return parsed as ExecutionJournalRecord;
  }

  private async quarantine(file: string): Promise<void> {
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async writeNow(executionId: string): Promise<void> {
    const record = this.records.get(executionId);
    if (!record) {
      throw new Error(`Execution journal record ${executionId} disappeared before its write`);
    }
    const contents = `${JSON.stringify(record, null, 2)}\n`;
    const target = this.fileFor(executionId);
    await mkdir(this.root, { recursive: true });
    await this.atomicWrite(target, contents);
  }

  private reportBackgroundError(executionId: string, error: unknown): void {
    if (this.backgroundErrorHandler) {
      this.backgroundErrorHandler(executionId, error);
      return;
    }
    // No handler is registered (for example in an isolated journal test). A
    // background write failure must still be observable, never swallowed.
    console.error(
      JSON.stringify({
        eventType: 'runner.journal_write_failed',
        message: 'Could not persist a debounced recovery journal update',
        executionId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private enqueue(executionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(executionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    // Keep the queue usable after a failed write; callers still see the
    // rejection on `run` and decide whether it is fatal.
    this.queues.set(
      executionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private fileFor(executionId: string): string {
    return join(this.root, `${sanitize(executionId)}.json`);
  }
}

async function defaultAtomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    // Cleanup is best-effort; the original journal failure is rethrown and
    // remains authoritative.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isValidRecord(value: Partial<ExecutionJournalRecord>): boolean {
  return Boolean(
    value &&
    value.version === 1 &&
    typeof value.executionId === 'string' &&
    value.executionId.length > 0 &&
    (value.runtime === 'codex' || value.runtime === 'opencode') &&
    typeof value.phase === 'string' &&
    typeof value.status === 'string' &&
    STATUS_VALUES.includes(value.status as ExecutionJournalStatus) &&
    typeof value.startedAt === 'string' &&
    typeof value.lastSequence === 'number',
  );
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return sanitized || 'execution';
}
