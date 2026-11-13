import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionPhase, RunnerRuntimeType } from '@raft-lite/contracts';
import { defaultEvidenceIo, writeCorruptProvenance, type EvidenceIo } from './recovery-evidence';

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
  /** Protected-root PID: the supervisor for new records, the CLI for legacy records. */
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
  /** Random token that ties the journal to exactly one supervisor/guard file. */
  launchToken?: string | null;
  /** Absolute path of the supervisor's durable guard file. */
  guardPath?: string | null;
  supervisorPid?: number | null;
  supervisorStartTime?: string | null;
  cliPid?: number | null;
  cliStartTime?: string | null;
  processKind?: 'supervisor' | 'direct' | null;
  /** Durable point in the launch sequence. */
  spawnState?: 'intent' | 'supervisor-ready' | 'running' | null;
  recoveryBlockedReason?: string | null;
  recoveryBlockedAt?: string | null;
  recoveryNote?: string | null;
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
    | 'launchToken'
    | 'guardPath'
    | 'supervisorPid'
    | 'supervisorStartTime'
    | 'cliPid'
    | 'cliStartTime'
    | 'processKind'
    | 'spawnState'
    | 'recoveryBlockedReason'
    | 'recoveryBlockedAt'
    | 'recoveryNote'
  >
>;

export interface CorruptJournalEntry {
  /** Original journal path, or the quarantined path if it was renamed. */
  path: string;
  quarantinedPath: string | null;
  error: string;
  detectedAt: string;
  /** Provenance written by the real quarantine path, when it could be created. */
  provenancePath?: string | null;
  provenanceError?: string | null;
}

export interface ExecutionJournalListResult {
  records: ExecutionJournalRecord[];
  corrupt: CorruptJournalEntry[];
}

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
  /** Test seam for the corrupt-isolation provenance write. */
  provenanceIo?: EvidenceIo;
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
  private readonly provenanceIo: EvidenceIo;
  private backgroundErrorHandler: ((executionId: string, error: unknown) => void) | null;

  constructor(
    private readonly root: string,
    private readonly options: ExecutionJournalOptions = {},
  ) {
    this.atomicWrite = options.atomicWrite ?? defaultAtomicWrite;
    this.provenanceIo = options.provenanceIo ?? defaultEvidenceIo;
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
    const inMemory = this.records.get(record.executionId);
    if (inMemory?.status === 'active') {
      throw new Error(
        `Execution journal ${record.executionId} is already active; refusing to overwrite recovery evidence`,
      );
    }
    const existing = await this.readFileDetailed(this.fileFor(record.executionId));
    if (existing.kind === 'corrupt') {
      throw new Error(
        `Execution journal ${record.executionId} is corrupt; refusing to overwrite recovery evidence`,
      );
    }
    if (existing.kind === 'ok' && existing.record.status === 'active') {
      throw new Error(
        `Execution journal ${record.executionId} is already active; refusing to overwrite recovery evidence`,
      );
    }
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
    return (await this.listDetailed()).records;
  }

  /**
   * Lists every readable journal and, separately, every corrupt one. Corruption
   * is never collapsed into an empty result: recovery must be able to block
   * startup when it cannot prove what a damaged record was doing.
   */
  async listDetailed(): Promise<ExecutionJournalListResult> {
    await this.flushAll();
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { records: [], corrupt: [] };
      }
      throw error;
    }
    const records: ExecutionJournalRecord[] = [];
    const corrupt: CorruptJournalEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      // Operator resolution sidecars live next to quarantined evidence; they
      // are not execution journals and must not be re-quarantined. The same is
      // true for the provenance written by the quarantine path.
      if (entry.name.endsWith('.resolution.json')) continue;
      if (entry.name.endsWith('.provenance.json')) continue;
      const result = await this.readFileDetailed(join(this.root, entry.name));
      if (result.kind === 'ok') {
        // Keep the loaded record addressable by finish()/update(); a startup
        // scan must be able to finalize a journal written by a previous process.
        this.records.set(result.record.executionId, result.record);
        records.push(result.record);
      } else if (result.kind === 'corrupt') {
        corrupt.push(result.entry);
      }
    }
    return {
      records: records.sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      corrupt: corrupt.sort((left, right) => left.path.localeCompare(right.path)),
    };
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
    const result = await this.readFileDetailed(file);
    return result.kind === 'ok' ? result.record : null;
  }

  private async readFileDetailed(
    file: string,
  ): Promise<
    | { kind: 'ok'; record: ExecutionJournalRecord }
    | { kind: 'missing' }
    | { kind: 'corrupt'; entry: CorruptJournalEntry }
  > {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
    let parsed: Partial<ExecutionJournalRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<ExecutionJournalRecord>;
    } catch (error) {
      return {
        kind: 'corrupt',
        entry: await this.recordCorruption(file, error, bestEffortExecutionId(raw)),
      };
    }
    if (!isValidRecord(parsed)) {
      return {
        kind: 'corrupt',
        entry: await this.recordCorruption(
          file,
          new Error('Execution journal failed validation'),
          bestEffortExecutionId(raw),
        ),
      };
    }
    return { kind: 'ok', record: parsed as ExecutionJournalRecord };
  }

  private async recordCorruption(
    file: string,
    error: unknown,
    executionId: string | null,
  ): Promise<CorruptJournalEntry> {
    this.options.onCorruptJournal?.(file, error);
    const quarantinedPath = await this.quarantine(file);
    let provenancePath: string | null = null;
    let provenanceError: string | null = null;
    if (quarantinedPath) {
      try {
        const provenance = await writeCorruptProvenance(
          quarantinedPath,
          this.root,
          executionId,
          this.provenanceIo,
        );
        provenancePath = provenance.path;
      } catch (writeError) {
        // The quarantined file stays evidence and remains blocked; a missing
        // provenance can never be resolved by an operator.
        provenanceError = writeError instanceof Error ? writeError.message : String(writeError);
        this.options.onCorruptJournal?.(quarantinedPath, writeError);
      }
    }
    return {
      path: file,
      quarantinedPath,
      error: error instanceof Error ? error.message : String(error),
      detectedAt: new Date().toISOString(),
      provenancePath,
      provenanceError,
    };
  }

  /** Renames a corrupt journal next to itself; it is never deleted. */
  private async quarantine(file: string): Promise<string | null> {
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, target);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
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
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ExecutionJournalRecord>;
  if (!(
    record.version === 1 &&
    nonEmptyString(record.executionId) &&
    (record.runtime === 'codex' || record.runtime === 'opencode') &&
    typeof record.phase === 'string' &&
    typeof record.status === 'string' &&
    STATUS_VALUES.includes(record.status as ExecutionJournalStatus) &&
    nonEmptyString(record.startedAt) &&
    nonEmptyString(record.updatedAt) &&
    (record.finishedAt === null || nonEmptyString(record.finishedAt)) &&
    typeof record.lastSequence === 'number' &&
    Number.isSafeInteger(record.lastSequence) &&
    record.lastSequence >= 0 &&
    optionalString(record.projectId) &&
    optionalString(record.worktreePath) &&
    optionalString(record.branchName) &&
    optionalString(record.baseCommit) &&
    optionalString(record.launchToken) &&
    optionalString(record.guardPath) &&
    optionalString(record.recoveryBlockedReason) &&
    optionalString(record.recoveryBlockedAt) &&
    optionalString(record.recoveryNote) &&
    optionalPid(record.supervisorPid) &&
    optionalPid(record.cliPid) &&
    optionalStartTime(record.supervisorStartTime) &&
    optionalStartTime(record.cliStartTime) &&
    validProcessKind(record.processKind) &&
    validSpawnState(record.spawnState)
  )) {
    return false;
  }

  // PID and process-identity fields are evidence, not hints. Missing values,
  // numeric strings, zero, negatives, fractions and unsafe integers must be
  // quarantined instead of being silently treated as "no process".
  if (!pidOrNull(record.pid)) return false;
  if (!(record.processStartTime === null || nonEmptyString(record.processStartTime))) return false;
  if (!(record.processGroupId === null || positiveSafeInteger(record.processGroupId))) return false;
  return validPidRelationships(record);
}

function validPidRelationships(record: Partial<ExecutionJournalRecord>): boolean {
  const processKind = record.processKind ?? null;
  const spawnState = record.spawnState ?? null;

  if (record.cliPid !== undefined && record.cliPid !== null) {
    if (record.pid !== undefined && record.pid !== null && record.cliPid === record.pid) {
      return false;
    }
  }

  if (spawnState === 'supervisor-ready') {
    if (processKind !== 'supervisor') return false;
    if (!positiveSafeInteger(record.pid)) return false;
    if (!positiveSafeInteger(record.supervisorPid)) return false;
    if (record.supervisorPid !== record.pid) return false;
    if (!nonEmptyString(record.supervisorStartTime)) return false;
  }
  if (spawnState === 'running' && !positiveSafeInteger(record.pid)) return false;

  if (processKind === 'direct') {
    // A directly spawned CLI has no supervisor identity and no supervisor guard
    // child identity. Keeping these fields empty is part of the schema.
    if (record.supervisorPid !== undefined && record.supervisorPid !== null) return false;
    if (record.cliPid !== undefined && record.cliPid !== null) return false;
    if (record.cliStartTime !== undefined && record.cliStartTime !== null) return false;
    if (spawnState === 'supervisor-ready') return false;
  }

  if (processKind === 'supervisor') {
    if (
      record.supervisorPid !== undefined &&
      record.supervisorPid !== null &&
      record.pid !== undefined &&
      record.pid !== null &&
      record.supervisorPid !== record.pid
    ) {
      return false;
    }
    if (spawnState === 'supervisor-ready' || spawnState === 'running') {
      // Once the supervisor is recorded as ready/running, both the protected
      // root PID and the supervisor PID are mandatory and must be identical.
      if (!positiveSafeInteger(record.pid)) return false;
      if (!positiveSafeInteger(record.supervisorPid)) return false;
      if (record.supervisorPid !== record.pid) return false;
      if (!nonEmptyString(record.supervisorStartTime)) return false;
    }
  }

  return true;
}

function bestEffortExecutionId(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const executionId = (parsed as { executionId?: unknown }).executionId;
    return typeof executionId === 'string' ? executionId : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function optionalStartTime(value: unknown): boolean {
  return value === undefined || value === null || nonEmptyString(value);
}

function pidOrNull(value: unknown): boolean {
  return value === null || positiveSafeInteger(value);
}

function optionalPid(value: unknown): boolean {
  return value === undefined || value === null || positiveSafeInteger(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validProcessKind(value: unknown): boolean {
  return value === undefined || value === null || value === 'supervisor' || value === 'direct';
}

function validSpawnState(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === 'intent' ||
    value === 'supervisor-ready' ||
    value === 'running'
  );
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return sanitized || 'execution';
}
