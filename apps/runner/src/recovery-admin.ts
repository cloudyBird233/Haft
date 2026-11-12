#!/usr/bin/env node
/**
 * Operator entry point for a Runner whose startup recovery is blocked.
 *
 * The Runner Protocol deliberately does not grow a "recovery" message. When
 * recovery cannot prove that a previous execution is gone, the Runner connects
 * in a degraded state, refuses new `execution.start` messages, and keeps the
 * active journal on disk. An operator inspects the evidence on the machine and
 * then either stops the remaining process or records an explicit resolution
 * with this tool.
 *
 * Commands:
 *   status [--root <path>] [--json]
 *   list   [--root <path>]
 *   resolve --root <path> --execution <id> --note "<why it is safe>"
 *   resolve-corrupt --root <path> --file <path> --note "<why it is safe>"
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExecutionJournal } from './execution-journal';
import { readProcessGuard, type ProcessGuardRecord } from './process-guard';
import { inspectProcess } from './process-identity';
import { ExecutionRecovery, type RecoveryBlockedEntry } from './recovery';

interface Options {
  command: 'status' | 'list' | 'resolve' | 'resolve-corrupt' | 'help';
  root: string;
  json: boolean;
  execution: string | null;
  file: string | null;
  note: string | null;
}

const HELP = `Haft Runner recovery administration

Usage:
  recovery-admin status  --root <recovery-root> [--json]
  recovery-admin list    --root <recovery-root>
  recovery-admin resolve --root <recovery-root> --execution <id> --note "<reason>"
  recovery-admin resolve-corrupt --root <recovery-root> --file <path> --note "<reason>"

The root is the Runner's recoveryRoot (HAFT_RUNNER_RECOVERY_ROOT). This tool
never deletes a journal, worktree or guard; it only records an operator
resolution after the underlying process has been proven gone.
`;

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const recovery = new ExecutionRecovery(options.root, {
    inspectProcess,
    terminateProcessTree: async () => {
      throw new Error('recovery-admin does not terminate processes; prove the process is gone first');
    },
    waitForProcessExit: async () => false,
    readGuard: readProcessGuard,
  });

  if (options.command === 'status' || options.command === 'list') {
    const blocked = await recovery.readBlockedState();
    const journals = await new ExecutionJournal(options.root).listDetailed();
    const status = {
      root: resolve(options.root),
      blocked,
      activeExecutions: journals.records
        .filter((record) => record.status === 'active')
        .map((record) => ({
          executionId: record.executionId,
          pid: record.pid,
          cliPid: record.cliPid ?? null,
          guardPath: record.guardPath ?? null,
          worktreePath: record.worktreePath,
          recoveryBlockedReason: record.recoveryBlockedReason ?? null,
          startedAt: record.startedAt,
        })),
      corruptJournals: journals.corrupt,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return status.blocked.length > 0 ? 1 : 0;
    }
    printStatus(status);
    return status.blocked.length > 0 ? 1 : 0;
  }

  if (options.command === 'resolve') {
    if (!options.execution || !options.note) {
      process.stderr.write('resolve requires --execution and --note\n');
      return 2;
    }
    const result = await recovery.resolveBlockedExecution(options.execution, options.note);
    process.stdout.write(`${result.resolved ? 'resolved' : 'NOT resolved'}: ${result.reason}\n`);
    return result.resolved ? 0 : 1;
  }

  if (!options.file || !options.note) {
    process.stderr.write('resolve-corrupt requires --file and --note\n');
    return 2;
  }
  const result = await recovery.resolveCorruptJournal(options.file, options.note);
  process.stdout.write(`${result.resolved ? 'resolved' : 'NOT resolved'}: ${result.reason}\n`);
  return result.resolved ? 0 : 1;
}

function parseArgs(argv: string[]): Options {
  const command = (argv[0] ?? 'help') as Options['command'];
  if (!['status', 'list', 'resolve', 'resolve-corrupt', 'help'].includes(command)) {
    throw new Error(`Unknown command: ${argv[0]}`);
  }
  const options: Options = {
    command,
    // Resolved after option parsing so `--root` works even when neither
    // HAFT_RUNNER_RECOVERY_ROOT nor HAFT_RUNNER_ID is set.
    root: '',
    json: false,
    execution: null,
    file: null,
    note: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--json') {
      options.json = true;
      continue;
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    index += 1;
    switch (key) {
      case '--root':
        options.root = value;
        break;
      case '--execution':
        options.execution = value;
        break;
      case '--file':
        options.file = value;
        break;
      case '--note':
        options.note = value;
        break;
      default:
        throw new Error(`Unknown option: ${key}`);
    }
  }
  if (!options.root && options.command !== 'help') options.root = defaultRoot();
  return options;
}

function defaultRoot(): string {
  const fromEnv = process.env.HAFT_RUNNER_RECOVERY_ROOT?.trim();
  if (fromEnv) return fromEnv;
  const runnerId = process.env.HAFT_RUNNER_ID?.trim();
  if (runnerId) return join(homedir(), '.haft', 'recovery', runnerId);
  throw new Error(
    'No recovery root: pass --root or set HAFT_RUNNER_RECOVERY_ROOT / HAFT_RUNNER_ID',
  );
}

function printStatus(status: {
  root: string;
  blocked: RecoveryBlockedEntry[];
  activeExecutions: Array<{
    executionId: string;
    pid: number | null;
    cliPid: number | null;
    guardPath: string | null;
    worktreePath: string | null;
    recoveryBlockedReason: string | null;
    startedAt: string;
  }>;
  corruptJournals: Array<{ path: string; quarantinedPath: string | null; error: string }>;
}): void {
  process.stdout.write(`recovery root: ${status.root}\n`);
  process.stdout.write(`blocked entries: ${status.blocked.length}\n`);
  for (const entry of status.blocked) {
    process.stdout.write(
      `  [${entry.kind}] ${entry.reason}\n    file: ${entry.file}\n    execution: ${entry.executionId ?? '-'} pid: ${entry.pid ?? '-'} cli: ${entry.cliPid ?? '-'}\n`,
    );
  }
  process.stdout.write(`active executions: ${status.activeExecutions.length}\n`);
  for (const entry of status.activeExecutions) {
    process.stdout.write(
      `  ${entry.executionId} pid=${entry.pid ?? '-'} cli=${entry.cliPid ?? '-'} blocked=${
        entry.recoveryBlockedReason ?? '-'
      }\n    guard: ${entry.guardPath ?? '-'}\n    worktree: ${entry.worktreePath ?? '-'}\n`,
    );
  }
  process.stdout.write(`corrupt journals: ${status.corruptJournals.length}\n`);
  for (const entry of status.corruptJournals) {
    process.stdout.write(`  ${entry.quarantinedPath ?? entry.path}: ${entry.error}\n`);
  }
}

// Exported for tests; the CLI entry never runs during an import.
export async function recoveryAdminStatus(root: string): Promise<{
  blocked: RecoveryBlockedEntry[];
  guards: ProcessGuardRecord[];
}> {
  const recovery = new ExecutionRecovery(root);
  const blocked = await recovery.readBlockedState();
  const guards: ProcessGuardRecord[] = [];
  const guardsDirectory = join(root, 'guards');
  let files: string[] = [];
  try {
    files = await readdir(guardsDirectory);
  } catch {
    files = [];
  }
  for (const name of files) {
    if (!name.endsWith('.guard.json')) continue;
    const read = await readProcessGuard(join(guardsDirectory, name));
    if (read.kind === 'ok') guards.push(read.guard);
  }
  return { blocked, guards };
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`recovery-admin: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
