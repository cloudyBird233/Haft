import { stat } from 'node:fs/promises';
import type { RunnerLogEntry } from '@raft-lite/contracts';
import {
  ExecutionJournal,
  type ExecutionJournalRecord,
} from './execution-journal';
import { LogSpool } from './log-spool';
import { log } from './logger';
import {
  inspectProcess,
  terminateProcessTree,
  waitForProcessExit,
  type ProcessIdentity,
} from './process-identity';

const TERMINAL_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ORPHAN_TERMINATION_WAIT_MS = 5000;

export interface RecoveryDependencies {
  inspectProcess(pid: number): Promise<ProcessIdentity | null>;
  terminateProcessTree(pid: number): Promise<void>;
  waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
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
  /** Best-effort check that the recorded worktree is still available for review. */
  worktreeExists: boolean;
  summary: string;
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
 * - Never delete a worktree or log spool during recovery.
 * - Only terminate a process whose PID still has the recorded start time and
 *   whose command line / process group belongs to this execution.
 */
export class ExecutionRecovery {
  readonly journal: ExecutionJournal;
  readonly spool: LogSpool;

  constructor(
    root: string,
    private readonly dependencies: RecoveryDependencies = {
      inspectProcess,
      terminateProcessTree,
      waitForProcessExit,
    },
  ) {
    this.journal = new ExecutionJournal(root);
    this.spool = new LogSpool(`${root}/logs`);
  }

  async scan(): Promise<RecoveredExecution[]> {
    const records = await this.journal.list();
    const recovered: RecoveredExecution[] = [];

    for (const record of records) {
      if (record.status !== 'active') continue;
      const identity = record.pid ? await this.dependencies.inspectProcess(record.pid) : null;
      const processAlive = Boolean(identity);
      const processIdentityUnverified = Boolean(
        identity && (!record.processStartTime || identity.startTime !== record.processStartTime),
      );
      const pidReused = Boolean(
        identity &&
          record.processStartTime &&
          identity.startTime !== record.processStartTime,
      );
      const ownershipMismatch = Boolean(
        identity && !processIdentityUnverified && !isOwnedProcess(identity, record),
      );

      let orphanTerminated = false;
      let orphanStillAlive = false;
      if (identity && !processIdentityUnverified && !ownershipMismatch) {
        try {
          await this.dependencies.terminateProcessTree(identity.pid);
          orphanTerminated = await this.dependencies.waitForProcessExit(
            identity.pid,
            ORPHAN_TERMINATION_WAIT_MS,
          );
          orphanStillAlive = !orphanTerminated;
        } catch {
          orphanStillAlive = true;
        }
      }

      const worktreeExists = await worktreePresent(record.worktreePath);
      const summary = buildRecoverySummary({
        record,
        processAlive,
        pidReused,
        ownershipMismatch,
        processIdentityUnverified,
        orphanTerminated,
        orphanStillAlive,
        worktreeExists,
      });
      await this.journal.finish(record.executionId, 'interrupted', record.phase, record.lastSequence);
      const logs = await this.spool.read(record.executionId, 200);

      log(orphanStillAlive ? 'warn' : 'info', {
        eventType: 'runner.recovery_scan',
        message: summary,
        status: orphanStillAlive ? 'warning' : 'interrupted',
        executionId: record.executionId,
        runtime: record.runtime,
        pid: record.pid,
        orphanTerminated,
        orphanStillAlive,
        worktreeExists,
      });

      recovered.push({
        record,
        logs,
        processAlive,
        pidReused,
        ownershipMismatch,
        processIdentityUnverified,
        orphanTerminated,
        orphanStillAlive,
        worktreeExists,
        summary,
      });
    }

    await this.journal.pruneTerminal(TERMINAL_JOURNAL_RETENTION_MS);
    return recovered;
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
}

function isOwnedProcess(identity: ProcessIdentity, record: ExecutionJournalRecord): boolean {
  const commandLine = normalize(identity.commandLine ?? '');
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
  worktreeExists: boolean;
}): string {
  const parts = [
    'RUNNER_INTERRUPTED: the runner restarted before this execution finished',
  ];
  if (!input.processAlive) {
    parts.push('no surviving CLI process was found');
  } else if (input.pidReused) {
    parts.push(
      `PID ${input.record.pid} now belongs to a different process; it was left untouched`,
    );
  } else if (input.processIdentityUnverified) {
    parts.push(
      `the process identity for PID ${input.record.pid} could not be verified; it was left untouched`,
    );
  } else if (input.ownershipMismatch) {
    parts.push(
      `PID ${input.record.pid} does not belong to this execution; it was left untouched`,
    );
  } else if (input.orphanTerminated) {
    parts.push('the orphaned CLI process tree was terminated');
  } else if (input.orphanStillAlive) {
    parts.push('the orphaned CLI process could not be confirmed terminated');
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
