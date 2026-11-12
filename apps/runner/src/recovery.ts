import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RunnerLogEntry } from '@raft-lite/contracts';
import {
  ExecutionJournal,
  type CorruptJournalEntry,
  type ExecutionJournalRecord,
} from './execution-journal';
import { LogSpool } from './log-spool';
import { log } from './logger';
import {
  guardControlPathFor,
  isGuardPathInsideRecoveryRoot,
  scanProcessGroupMembers,
  readProcessGuard,
  sameStartTime,
  terminateGuardedTree,
  verifyGuardedTree,
  type GuardReadResult,
  type ProcessGuardRecord,
} from './process-guard';
import {
  inspectProcess,
  isProcessAlive,
  terminateProcessTree,
  waitForProcessExit,
  type ProcessIdentity,
} from './process-identity';

const TERMINAL_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ORPHAN_TERMINATION_WAIT_MS = 5000;
const LEGACY_GROUP_CHECK_TIMEOUT_MS = 2000;

export interface RecoveryDependencies {
  inspectProcess(pid: number): Promise<ProcessIdentity | null>;
  terminateProcessTree(pid: number): Promise<void>;
  waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
  readGuard?(path: string): Promise<GuardReadResult>;
}

export interface RecoveredExecution {
  record: ExecutionJournalRecord;
  logs: RunnerLogEntry[];
  processAlive: boolean;
  pidReused: boolean;
  ownershipMismatch: boolean;
  processIdentityUnverified: boolean;
  orphanTerminated: boolean;
  orphanStillAlive: boolean;
  /** True only when the whole protected tree is proven gone. */
  treeConfirmedGone: boolean;
  /** True when recovery could not prove whether the execution's process still exists. */
  processStateUnknown: boolean;
  /** False when the on-disk journal remains active as manual-recovery evidence. */
  journalFinalized: boolean;
  /** True when recovery refuses to finalize and blocks new executions. */
  recoveryBlocked: boolean;
  blockedReason: string | null;
  guard: ProcessGuardRecord | null;
  /** Best-effort check that the recorded worktree is still available for review. */
  worktreeExists: boolean;
  summary: string;
}

export interface RecoveryBlockedEntry {
  kind: 'journal' | 'corrupt-journal' | 'corrupt-guard' | 'orphan-guard';
  executionId: string | null;
  file: string;
  reason: string;
  pid: number | null;
  processStartTime: string | null;
  cliPid: number | null;
  worktreePath: string | null;
  detectedAt: string;
}

export interface RecoveryScanResult {
  executions: RecoveredExecution[];
  corrupted: CorruptJournalEntry[];
  blocked: RecoveryBlockedEntry[];
  clean: boolean;
  /** Absolute path of the persisted blocked-state ledger. */
  statePath: string;
}

/**
 * Runner crash recovery.
 *
 * `scan()` is called once at process startup before the socket connects. Each
 * `active` journal record belongs to a previous runner process (the current
 * process has no sessions yet), so it is either stale or an orphaned CLI.
 *
 * Safety rules:
 * - Never start a replacement execution.
 * - Never delete a worktree, log spool or corrupt journal during recovery.
 * - Never finalize an active record unless the whole protected process tree is
 *   proven gone. A PID alone (or the absence of a PID) is not proof.
 * - Never kill a PID whose live start marker does not match the recorded one.
 * - Any uncertainty becomes a persisted `recovery-blocked` entry; the runner
 *   refuses new executions until an operator resolves it.
 */
export class ExecutionRecovery {
  readonly journal: ExecutionJournal;
  readonly spool: LogSpool;
  private readonly rootPath: string;
  private lastBlocked: RecoveryBlockedEntry[] = [];
  private readonly dependencies: Required<Pick<RecoveryDependencies, 'inspectProcess' | 'terminateProcessTree' | 'waitForProcessExit'>> &
    Pick<RecoveryDependencies, 'readGuard'>;

  constructor(
    root: string,
    dependencies: RecoveryDependencies = {
      inspectProcess,
      terminateProcessTree: async (pid: number) => {
        const result = await terminateProcessTree(pid);
        if (!result.confirmed) {
          throw new Error(result.error ?? `Could not confirm PID ${pid} exited`);
        }
      },
      waitForProcessExit,
      readGuard: readProcessGuard,
    },
  ) {
    this.rootPath = resolve(root);
    this.dependencies = {
      inspectProcess: dependencies.inspectProcess,
      terminateProcessTree: dependencies.terminateProcessTree,
      waitForProcessExit: dependencies.waitForProcessExit,
      readGuard: dependencies.readGuard ?? readProcessGuard,
    };
    this.journal = new ExecutionJournal(root, {
      onCorruptJournal: (file, error) => {
        log('error', {
          eventType: 'runner.recovery_journal_corrupt',
          message: 'A recovery journal could not be read; it was quarantined as evidence',
          status: 'error',
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.spool = new LogSpool(`${root}/logs`);
  }

  async scan(): Promise<RecoveryScanResult> {
    const listing = await this.journal.listDetailed();
    const executions: RecoveredExecution[] = [];
    const blocked: RecoveryBlockedEntry[] = [];

    for (const entry of listing.corrupt) {
      blocked.push({
        kind: 'corrupt-journal',
        executionId: null,
        file: entry.quarantinedPath ?? entry.path,
        reason: `CORRUPT_JOURNAL: ${entry.error}`,
        pid: null,
        processStartTime: null,
        cliPid: null,
        worktreePath: null,
        detectedAt: entry.detectedAt,
      });
    }

    for (const record of listing.records) {
      if (record.status !== 'active') continue;
      executions.push(await this.recoverActive(record, blocked));
    }

    blocked.push(...(await this.findUnresolvedCorruptEvidence(listing.records)));
    const deduped = dedupeBlocked(blocked);
    this.lastBlocked = deduped;

    const statePath = this.blockedStatePath();
    await this.persistBlockedState(statePath, deduped);

    await this.journal.pruneTerminal(TERMINAL_JOURNAL_RETENTION_MS);
    return {
      executions,
      corrupted: listing.corrupt,
      blocked: deduped,
      clean: deduped.length === 0,
      statePath,
    };
  }

  appendLog(executionId: string, entry: RunnerLogEntry): Promise<void> {
    return this.spool.append(executionId, entry);
  }

  acknowledgeLogs(executionId: string, throughSeq: number): Promise<number> {
    return this.spool.acknowledge(executionId, throughSeq);
  }

  readLogs(executionId: string, limit?: number): Promise<RunnerLogEntry[]> {
    return this.spool.read(executionId, limit);
  }

  /** True when a blocked worktree must not be reused by another execution. */
  isWorktreeBlocked(worktreePath: string | null): boolean {
    return this.blockedWorktrees().has(normalizeWorktree(worktreePath));
  }

  async readBlockedState(): Promise<RecoveryBlockedEntry[]> {
    const path = this.blockedStatePath();
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(isBlockedEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  /** Operator entry point: finalize a blocked record after out-of-band proof. */
  async resolveBlockedExecution(
    executionId: string,
    note: string,
  ): Promise<{ resolved: boolean; reason: string }> {
    const record = await this.journal.read(executionId);
    if (!record) {
      return { resolved: false, reason: `No journal exists for execution ${executionId}` };
    }
    if (record.status !== 'active') {
      return { resolved: false, reason: `Execution ${executionId} is already ${record.status}` };
    }
    const verification = await this.verifyRecord(record);
    if (verification?.processAlive) {
      return {
        resolved: false,
        reason: `A live process still matches execution ${executionId}; terminate it before resolving`,
      };
    }
    await this.journal.finish(record.executionId, 'interrupted', record.phase, record.lastSequence);
    await this.journal.update(
      executionId,
      {
        recoveryNote: note.slice(0, 2000),
        recoveryBlockedReason: null,
        recoveryBlockedAt: null,
      },
      { immediate: true },
    );
    await this.writeResolution(executionId, note);
    this.lastBlocked = this.lastBlocked.filter(
      (entry) => entry.executionId !== executionId,
    );
    await this.persistBlockedState(this.blockedStatePath(), this.lastBlocked);
    return { resolved: true, reason: 'Journal marked interrupted by operator resolution' };
  }

  async resolveCorruptJournal(
    file: string,
    note: string,
  ): Promise<{ resolved: boolean; reason: string }> {
    const target = resolve(file);
    const root = resolve(this.root());
    if (!target.startsWith(`${root}${separatorForPlatform()}`) && target !== root) {
      return { resolved: false, reason: 'The journal file is outside the recovery root' };
    }
    try {
      await stat(target);
    } catch {
      return { resolved: false, reason: `${target} does not exist` };
    }
    await writeFile(
      `${target}.resolution.json`,
      `${JSON.stringify(
        { version: 1, resolution: 'operator-confirmed-process-gone', note, resolvedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      'utf8',
    );
    this.lastBlocked = this.lastBlocked.filter(
      (entry) => resolve(entry.file).toLowerCase() !== target.toLowerCase(),
    );
    await this.persistBlockedState(this.blockedStatePath(), this.lastBlocked);
    return { resolved: true, reason: 'Corrupt journal kept as evidence with a resolution sidecar' };
  }

  private async recoverActive(
    record: ExecutionJournalRecord,
    blocked: RecoveryBlockedEntry[],
  ): Promise<RecoveredExecution> {
    const worktreeExists = await worktreePresent(record.worktreePath);
    const guardResult = await this.loadGuard(record);
    if (guardResult.kind === 'invalid' || guardResult.kind === 'mismatch') {
      return this.blockRecord(record, blocked, guardResult.error, {
        worktreeExists,
        treeConfirmedGone: false,
      });
    }

    if (guardResult.kind === 'ok') {
      return this.recoverGuarded(record, guardResult.guard, worktreeExists, blocked);
    }

    if (record.processKind === 'supervisor') {
      return this.blockRecord(
        record,
        blocked,
        'SUPERVISOR_GUARD_MISSING: the journal records a supervisor but no durable guard exists',
        { worktreeExists, treeConfirmedGone: false },
      );
    }

    return this.recoverLegacy(record, worktreeExists, blocked);
  }

  private async recoverGuarded(
    record: ExecutionJournalRecord,
    guard: ProcessGuardRecord,
    worktreeExists: boolean,
    blocked: RecoveryBlockedEntry[],
  ): Promise<RecoveredExecution> {
    let verification = await verifyGuardedTree(guard, {
      inspectProcess: this.dependencies.inspectProcess,
    });
    let orphanTerminated = false;
    let orphanStillAlive = false;

    if (!verification.confirmed) {
      const termination = await terminateGuardedTree(
        guard,
        guardControlPathFor(record.guardPath as string),
        {
          inspectProcess: this.dependencies.inspectProcess,
          terminateProcessTree: this.dependencies.terminateProcessTree,
          waitForProcessExit: this.dependencies.waitForProcessExit,
        },
        {
          supervisorConfirmMs: ORPHAN_TERMINATION_WAIT_MS,
          verifyTimeoutMs: ORPHAN_TERMINATION_WAIT_MS,
          readGuard: async () => {
            const guardPath = record.guardPath;
            if (!guardPath) return null;
            const read = await (this.dependencies.readGuard ?? readProcessGuard)(guardPath);
            return read.kind === 'ok' ? read.guard : null;
          },
        },
      );
      orphanTerminated = termination.confirmed && termination.killIssued;
      orphanStillAlive = !termination.confirmed;
      verification = termination;
    }

    if (verification.identityMismatch) {
      return this.blockRecord(
        record,
        blocked,
        `PID_IDENTITY_UNVERIFIED: ${verification.reason}`,
        { worktreeExists, treeConfirmedGone: false, guard },
      );
    }

    if (!verification.confirmed) {
      return this.blockRecord(
        record,
        blocked,
        `PROCESS_TREE_NOT_CONFIRMED: ${verification.reason}`,
        { worktreeExists, treeConfirmedGone: false, guard },
      );
    }

    const finalized = await this.tryFinalize(record, blocked, { worktreeExists, guard });
    return this.reportFromRecord(record, {
      worktreeExists,
      guard,
      treeConfirmedGone: true,
      journalFinalized: finalized.journalFinalized,
      recoveryBlocked: !finalized.journalFinalized,
      blockedReason: finalized.journalFinalized ? null : finalized.reason,
      orphanTerminated,
      orphanStillAlive,
      processAlive: false,
      processStateUnknown: false,
      pidReused: false,
      ownershipMismatch: false,
      processIdentityUnverified: false,
      logs: await this.spool.read(record.executionId, 200),
    });
  }

  private async recoverLegacy(
    record: ExecutionJournalRecord,
    worktreeExists: boolean,
    blocked: RecoveryBlockedEntry[],
  ): Promise<RecoveredExecution> {
    if (record.pid === null) {
      // F-01: an active journal without a PID may still correspond to a live
      // CLI that was spawned before the crash. Absence of identity is not
      // evidence of absence.
      return this.blockRecord(
        record,
        blocked,
        'PID_NOT_RECORDED: an active journal has no process identity; the process state cannot be proven',
        { worktreeExists, treeConfirmedGone: false },
      );
    }

    const identity = await this.dependencies.inspectProcess(record.pid);
    if (!identity && isProcessAlive(record.pid)) {
      // A failed inspection is not proof that the PID is gone. Without the
      // start marker we cannot kill it, so keep the journal active and block.
      return this.blockRecord(
        record,
        blocked,
        `PID_IDENTITY_UNVERIFIED: PID ${record.pid} is alive but its identity could not be inspected`,
        { worktreeExists, treeConfirmedGone: false, processAlive: true },
      );
    }
    const processAlive = Boolean(identity);
    const processIdentityUnverified = Boolean(
      identity &&
        (!record.processStartTime ||
          !sameStartTime(record.processStartTime, identity.startTime)),
    );
    const pidReused = Boolean(
      identity &&
        record.processStartTime &&
        !sameStartTime(record.processStartTime, identity.startTime),
    );
    const ownershipMismatch = Boolean(
      identity && !processIdentityUnverified && !isOwnedProcess(identity, record),
    );

    if (processAlive && (processIdentityUnverified || ownershipMismatch)) {
      return this.blockRecord(
        record,
        blocked,
        pidReused
          ? `PID_REUSED: PID ${record.pid} now belongs to a different process`
          : ownershipMismatch
            ? `PID_OWNERSHIP_MISMATCH: PID ${record.pid} does not belong to this execution`
            : `PID_IDENTITY_UNVERIFIED: PID ${record.pid} has no matching start marker`,
        { worktreeExists, treeConfirmedGone: false, processAlive },
      );
    }

    let orphanTerminated = false;
    let orphanStillAlive = false;
    let treeConfirmedGone = !processAlive;

    if (processAlive) {
      try {
        await this.dependencies.terminateProcessTree(record.pid);
        const exited = await this.dependencies.waitForProcessExit(
          record.pid,
          ORPHAN_TERMINATION_WAIT_MS,
        );
        orphanStillAlive = !exited;
        orphanTerminated = exited;
        treeConfirmedGone = exited && (await this.legacyTreeGone(record));
      } catch {
        orphanStillAlive = true;
        treeConfirmedGone = false;
      }
    } else if (process.platform !== 'win32' && record.processGroupId) {
      const scan = await scanProcessGroupMembers(record.processGroupId);
      if (!scan.ok || scan.members.length > 0) {
        treeConfirmedGone = false;
      }
    }

    if (!treeConfirmedGone) {
      return this.blockRecord(
        record,
        blocked,
        orphanStillAlive
          ? `PROCESS_TREE_NOT_CONFIRMED: PID ${record.pid} or its process group is still alive`
          : `PROCESS_GROUP_NOT_EMPTY: process group ${record.processGroupId ?? 'unknown'} still has members`,
        { worktreeExists, treeConfirmedGone, processAlive },
      );
    }

    const finalized = await this.tryFinalize(record, blocked, { worktreeExists, guard: null });
    return this.reportFromRecord(record, {
      worktreeExists,
      guard: null,
      treeConfirmedGone: true,
      journalFinalized: finalized.journalFinalized,
      recoveryBlocked: !finalized.journalFinalized,
      blockedReason: finalized.journalFinalized ? null : finalized.reason,
      orphanTerminated,
      orphanStillAlive,
      processAlive,
      processStateUnknown: false,
      pidReused,
      ownershipMismatch,
      processIdentityUnverified,
      logs: await this.spool.read(record.executionId, 200),
    });
  }

  private async legacyTreeGone(record: ExecutionJournalRecord): Promise<boolean> {
    if (process.platform === 'win32' || !record.processGroupId) return true;
    const deadline = Date.now() + LEGACY_GROUP_CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const scan = await scanProcessGroupMembers(record.processGroupId);
      if (scan.ok && scan.members.length === 0) return true;
      await delay(50);
    }
    return false;
  }

  private async tryFinalize(
    record: ExecutionJournalRecord,
    blocked: RecoveryBlockedEntry[],
    context: { worktreeExists: boolean; guard: ProcessGuardRecord | null },
  ): Promise<{ journalFinalized: boolean; reason: string | null }> {
    try {
      await this.journal.finish(
        record.executionId,
        'interrupted',
        record.phase,
        record.lastSequence,
      );
      return { journalFinalized: true, reason: null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = `JOURNAL_FINALIZE_FAILED: ${detail}`;
      await this.markJournalBlocked(record.executionId, reason);
      blocked.push({
        kind: 'journal',
        executionId: record.executionId,
        file: this.journalPath(record),
        reason,
        pid: record.pid,
        processStartTime: record.processStartTime,
        cliPid: record.cliPid ?? null,
        worktreePath: record.worktreePath,
        detectedAt: new Date().toISOString(),
      });
      log('error', {
        eventType: 'runner.recovery_journal_finalize_failed',
        message: 'Could not persist the interrupted state of a recovered execution',
        status: 'error',
        executionId: record.executionId,
        error: detail,
        worktreeExists: context.worktreeExists,
        guardPath: record.guardPath ?? null,
      });
      return { journalFinalized: false, reason };
    }
  }

  private async blockRecord(
    record: ExecutionJournalRecord,
    blocked: RecoveryBlockedEntry[],
    reason: string,
    context: {
      worktreeExists: boolean;
      treeConfirmedGone: boolean;
      guard?: ProcessGuardRecord | null;
      processAlive?: boolean;
    },
  ): Promise<RecoveredExecution> {
    const reasonText = reason.slice(0, 2000);
    await this.markJournalBlocked(record.executionId, reasonText);
    blocked.push({
      kind: 'journal',
      executionId: record.executionId,
      file: this.journalPath(record),
      reason: reasonText,
      pid: record.pid,
      processStartTime: record.processStartTime,
      cliPid: record.cliPid ?? null,
      worktreePath: record.worktreePath,
      detectedAt: new Date().toISOString(),
    });
    const logs = await this.spool.read(record.executionId, 200);
    const summary = `RUNNER_RECOVERY_BLOCKED: ${reasonText}`;
    log('error', {
      eventType: 'runner.recovery_blocked',
      message: summary,
      status: 'error',
      executionId: record.executionId,
      pid: record.pid,
      cliPid: record.cliPid ?? null,
      worktreePath: record.worktreePath,
      journalFinalized: false,
      treeConfirmedGone: context.treeConfirmedGone,
    });
    return this.reportFromRecord(record, {
      worktreeExists: context.worktreeExists,
      guard: context.guard ?? null,
      treeConfirmedGone: context.treeConfirmedGone,
      journalFinalized: false,
      recoveryBlocked: true,
      blockedReason: reasonText,
      orphanTerminated: false,
      orphanStillAlive: true,
      processAlive: context.processAlive ?? false,
      processStateUnknown: true,
      pidReused: reasonText.startsWith('PID_REUSED'),
      ownershipMismatch: reasonText.startsWith('PID_OWNERSHIP_MISMATCH'),
      processIdentityUnverified:
        reasonText.startsWith('PID_IDENTITY') || reasonText.startsWith('SUPERVISOR_GUARD'),
      logs,
    });
  }

  private reportFromRecord(
    record: ExecutionJournalRecord,
    values: {
      worktreeExists: boolean;
      guard: ProcessGuardRecord | null;
      treeConfirmedGone: boolean;
      journalFinalized: boolean;
      recoveryBlocked: boolean;
      blockedReason: string | null;
      orphanTerminated: boolean;
      orphanStillAlive: boolean;
      processAlive: boolean;
      processStateUnknown: boolean;
      pidReused: boolean;
      ownershipMismatch: boolean;
      processIdentityUnverified: boolean;
      logs?: RunnerLogEntry[];
    },
  ): RecoveredExecution {
    const summary = buildRecoverySummary({
      record,
      processAlive: values.processAlive,
      pidReused: values.pidReused,
      ownershipMismatch: values.ownershipMismatch,
      processIdentityUnverified: values.processIdentityUnverified,
      orphanTerminated: values.orphanTerminated,
      orphanStillAlive: values.orphanStillAlive,
      treeConfirmedGone: values.treeConfirmedGone,
      recoveryBlocked: values.recoveryBlocked,
      blockedReason: values.blockedReason,
      worktreeExists: values.worktreeExists,
    });
    return {
      record,
      logs: values.logs ?? [],
      processAlive: values.processAlive,
      pidReused: values.pidReused,
      ownershipMismatch: values.ownershipMismatch,
      processIdentityUnverified: values.processIdentityUnverified,
      orphanTerminated: values.orphanTerminated,
      orphanStillAlive: values.orphanStillAlive,
      treeConfirmedGone: values.treeConfirmedGone,
      processStateUnknown: values.processStateUnknown,
      journalFinalized: values.journalFinalized,
      recoveryBlocked: values.recoveryBlocked,
      blockedReason: values.blockedReason,
      guard: values.guard,
      worktreeExists: values.worktreeExists,
      summary,
    };
  }

  private async loadGuard(
    record: ExecutionJournalRecord,
  ): Promise<
    | { kind: 'ok'; guard: ProcessGuardRecord & { path?: string } }
    | { kind: 'missing' }
    | { kind: 'invalid'; error: string }
    | { kind: 'mismatch'; error: string }
  > {
    if (!record.guardPath) return { kind: 'missing' };
    if (!isGuardPathInsideRecoveryRoot(this.root(), record.guardPath)) {
      return { kind: 'invalid', error: 'SUPERVISOR_GUARD_OUTSIDE_RECOVERY_ROOT' };
    }
    const read = await (this.dependencies.readGuard ?? readProcessGuard)(record.guardPath);
    if (read.kind === 'missing') return { kind: 'missing' };
    if (read.kind === 'invalid') return { kind: 'invalid', error: `SUPERVISOR_GUARD_CORRUPT: ${read.error}` };
    if (
      read.guard.executionId !== record.executionId ||
      (record.launchToken && read.guard.launchToken !== record.launchToken)
    ) {
      return {
        kind: 'mismatch',
        error: 'SUPERVISOR_GUARD_IDENTITY_MISMATCH: the guard belongs to a different execution',
      };
    }
    return { kind: 'ok', guard: { ...read.guard, path: read.path } };
  }

  private async verifyRecord(
    record: ExecutionJournalRecord,
  ): Promise<{ processAlive: boolean } | null> {
    const guardResult = await this.loadGuard(record);
    if (guardResult.kind === 'ok') {
      const verification = await verifyGuardedTree(guardResult.guard, {
        inspectProcess: this.dependencies.inspectProcess,
      });
      return {
        processAlive:
          verification.supervisor?.status === 'live-matching' ||
          verification.cli?.status === 'live-matching',
      };
    }
    if (record.pid === null) return { processAlive: false };
    const identity = await this.dependencies.inspectProcess(record.pid);
    if (!identity) return { processAlive: isProcessAlive(record.pid) };
    if (!record.processStartTime || !sameStartTime(record.processStartTime, identity.startTime)) {
      return { processAlive: false };
    }
    return { processAlive: true };
  }

  private async markJournalBlocked(executionId: string, reason: string): Promise<void> {
    try {
      await this.journal.update(
        executionId,
        {
          recoveryBlockedReason: reason.slice(0, 2000),
          recoveryBlockedAt: new Date().toISOString(),
        },
        { immediate: true },
      );
    } catch (error) {
      log('error', {
        eventType: 'runner.recovery_blocked_persist_failed',
        message: 'Could not persist the recovery-blocked marker on the journal',
        status: 'error',
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async findUnresolvedCorruptEvidence(
    records: ExecutionJournalRecord[],
  ): Promise<RecoveryBlockedEntry[]> {
    const blocked: RecoveryBlockedEntry[] = [];
    const root = this.root();
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!/\.corrupt-\d+$/.test(name)) continue;
      const file = join(root, name);
      if (await resolutionExists(file)) continue;
      blocked.push({
        kind: 'corrupt-journal',
        executionId: null,
        file,
        reason: 'UNRESOLVED_CORRUPT_JOURNAL: an operator must confirm the process state',
        pid: null,
        processStartTime: null,
        cliPid: null,
        worktreePath: null,
        detectedAt: new Date().toISOString(),
      });
    }

    const referencedGuards = new Set(
      records
        .map((record) => record.guardPath)
        .filter((path): path is string => typeof path === 'string')
        .map((path) => resolve(path)),
    );
    const guardsDirectory = join(root, 'guards');
    let guardEntries: string[] = [];
    try {
      guardEntries = await readdir(guardsDirectory);
    } catch {
      guardEntries = [];
    }
    for (const name of guardEntries) {
      if (!name.endsWith('.guard.json')) continue;
      const file = join(guardsDirectory, name);
      if (referencedGuards.has(resolve(file))) continue;
      if (await resolutionExists(file)) continue;
      const read = await (this.dependencies.readGuard ?? readProcessGuard)(file);
      if (read.kind === 'invalid') {
        blocked.push({
          kind: 'corrupt-guard',
          executionId: null,
          file,
          reason: `CORRUPT_GUARD: ${read.error}`,
          pid: null,
          processStartTime: null,
          cliPid: null,
          worktreePath: null,
          detectedAt: new Date().toISOString(),
        });
      } else if (read.kind === 'ok' && !read.guard.treeConfirmedGone) {
        blocked.push({
          kind: 'orphan-guard',
          executionId: read.guard.executionId,
          file,
          reason: 'ORPHAN_GUARD: a guard is not linked to a readable active journal and its tree is not confirmed gone',
          pid: read.guard.supervisorPid,
          processStartTime: read.guard.supervisorStartTime,
          cliPid: read.guard.cliPid,
          worktreePath: null,
          detectedAt: new Date().toISOString(),
        });
      }
    }
    return blocked;
  }

  private blockedWorktrees(): Set<string> {
    return new Set(
      this.lastBlocked
        .map((entry) => normalizeWorktree(entry.worktreePath))
        .filter((path) => path.length > 0),
    );
  }

  private async persistBlockedState(
    path: string,
    entries: RecoveryBlockedEntry[],
  ): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify(
          { version: 1, updatedAt: new Date().toISOString(), entries },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await rename(temporary, path);
    } catch (error) {
      log('error', {
        eventType: 'runner.recovery_blocked_state_failed',
        message: 'Could not persist the recovery-blocked ledger',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async writeResolution(executionId: string, note: string): Promise<void> {
    const path = join(this.root(), 'state', 'resolutions', `${sanitize(executionId)}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        { version: 1, executionId, note, resolvedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  private blockedStatePath(): string {
    return join(this.root(), 'state', 'blocked.json');
  }

  private journalPath(record: ExecutionJournalRecord): string {
    return join(this.root(), `${sanitize(record.executionId)}.json`);
  }

  private root(): string {
    return this.rootPath;
  }
}

function dedupeBlocked(entries: RecoveryBlockedEntry[]): RecoveryBlockedEntry[] {
  const seen = new Set<string>();
  const result: RecoveryBlockedEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.file}:${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function isBlockedEntry(value: unknown): value is RecoveryBlockedEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<RecoveryBlockedEntry>;
  return (
    typeof entry.kind === 'string' &&
    typeof entry.reason === 'string' &&
    typeof entry.file === 'string'
  );
}

async function resolutionExists(file: string): Promise<boolean> {
  try {
    await stat(`${file}.resolution.json`);
    return true;
  } catch {
    return false;
  }
}

function isOwnedProcess(identity: ProcessIdentity, record: ExecutionJournalRecord): boolean {
  const commandLine = normalize(identity.commandLine ?? '');
  if (record.launchToken && commandLine.includes(record.launchToken.toLowerCase())) {
    return true;
  }
  if (record.executionId && commandLine.includes(record.executionId.toLowerCase())) {
    return true;
  }
  const worktree = normalize(record.worktreePath ?? '');
  if (worktree && commandLine.includes(worktree)) return true;
  if (record.runtime && commandLine.includes(record.runtime)) return true;
  if (
    identity.processGroupId !== null &&
    record.processGroupId !== null &&
    identity.processGroupId === record.processGroupId
  ) {
    return true;
  }
  return false;
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function normalizeWorktree(value: string | null): string {
  return value ? normalize(value) : '';
}

async function worktreePresent(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // Permission errors or an unmounted volume are not evidence of deletion;
    // the summary only reports that the worktree could not be found.
    return false;
  }
}

function buildRecoverySummary(input: {
  record: ExecutionJournalRecord;
  processAlive: boolean;
  pidReused: boolean;
  ownershipMismatch: boolean;
  processIdentityUnverified: boolean;
  orphanTerminated: boolean;
  orphanStillAlive: boolean;
  treeConfirmedGone: boolean;
  recoveryBlocked: boolean;
  blockedReason: string | null;
  worktreeExists: boolean;
}): string {
  const parts = ['RUNNER_INTERRUPTED: the runner restarted before this execution finished'];
  if (input.recoveryBlocked) {
    parts.push(`recovery is blocked: ${input.blockedReason ?? 'the process state is uncertain'}`);
  } else if (input.treeConfirmedGone) {
    if (input.orphanTerminated) {
      parts.push('the orphaned protected process tree was terminated and confirmed gone');
    } else if (!input.processAlive) {
      parts.push('no surviving protected CLI process was found');
    } else {
      parts.push('the protected process tree is confirmed gone');
    }
  } else if (input.pidReused) {
    parts.push(`PID ${input.record.pid} now belongs to a different process; it was left untouched`);
  } else if (input.processIdentityUnverified) {
    parts.push(
      `the process identity for PID ${input.record.pid} could not be verified; it was left untouched`,
    );
  } else if (input.ownershipMismatch) {
    parts.push(`PID ${input.record.pid} does not belong to this execution; it was left untouched`);
  } else if (input.orphanStillAlive) {
    parts.push('the orphaned protected process tree could not be confirmed terminated');
  }
  const worktree = input.record.worktreePath
    ? input.worktreeExists
      ? `; worktree preserved at ${input.record.worktreePath}`
      : `; worktree path ${input.record.worktreePath} could not be found and was not modified`
    : '';
  const logs = input.record.lastSequence
    ? `; ${input.record.lastSequence} runner log sequence(s) preserved`
    : '';
  return `${parts.join('; ')}${worktree}${logs}.`.slice(0, 2000);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'execution';
}

function separatorForPlatform(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
