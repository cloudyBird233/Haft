/**
 * POSIX process supervisor.
 *
 * This file is intentionally dependency-free (Node builtins only) because it
 * is launched as a separate OS process. The runner never spawns a real CLI
 * directly: it spawns this supervisor first, waits until the guard file proves
 * that a cgroup/process-group exists, and only then does the supervisor create
 * the CLI.
 *
 * Lifecycle guarantees:
 * - The guard file is written before the CLI is created.
 * - The supervisor joins a private cgroup (Linux, when available) or keeps the
 *   runner-created session/process-group, so the CLI and its descendants are
 *   addressable as one tree.
 * - Parent death, SIGTERM/SIGINT and a control file all lead to the same
 *   verified tree-kill path. The supervisor does not exit until every member
 *   except itself is gone (or it records an explicit `unconfirmed` state).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { ProcessGuardIsolation, ProcessGuardRecord, ProcessGuardState } from './process-guard';
import { assertGuardPathAvailable, readValidatedStartingGuard } from './process-supervisor-guard';

interface SupervisorConfig {
  guardPath: string;
  controlPath: string;
  executionId: string;
  launchToken: string;
  parentPid: number;
  parentStartTime: string;
  cwd: string;
  command: string;
  args: string[];
}

const FAILED_BEFORE_CLI_EXIT = 70;
const PARENT_POLL_MS = 100;
const CONTROL_POLL_MS = 100;
const TREE_CONFIRM_TIMEOUT_MS = 15_000;
const GRACEFUL_WAIT_MS = 3_000;

const config = parseConfig(process.argv.slice(2));
const startedAt = new Date().toISOString();
const supervisorStartTime = readProcessStartTime(process.pid);
const processGroupId = readProcessGroupId(process.pid);
const isolation = installIsolation();
const guard: ProcessGuardRecord = {
  version: 1,
  executionId: config.executionId,
  launchToken: config.launchToken,
  parentPid: config.parentPid,
  supervisorPid: process.pid,
  supervisorStartTime: supervisorStartTime ?? 'unknown',
  processGroupId,
  cgroupPath: isolation.cgroupPath,
  cliPid: null,
  cliStartTime: null,
  isolation: isolation.kind,
  state: 'starting',
  jobCreated: isolation.installed,
  treeConfirmedGone: false,
  exitCode: null,
  signal: null,
  detail: null,
  createdAt: startedAt,
  updatedAt: startedAt,
};

let child: ChildProcess | null = null;
let terminating = false;
let finished = false;
let parentTimer: NodeJS.Timeout | null = null;
let controlTimer: NodeJS.Timeout | null = null;

main().catch(async (error: unknown) => {
  appendLog(`fatal: ${errorMessage(error)}`);
  if (child?.pid) {
    await eliminateTree(true);
  }
  updateGuard({
    state: child?.pid ? 'unconfirmed' : 'failed',
    treeConfirmedGone: child?.pid ? false : true,
    detail: `supervisor failure: ${errorMessage(error)}`,
  });
  cleanupIsolation();
  process.exit(FAILED_BEFORE_CLI_EXIT);
});

async function main(): Promise<void> {
  if (!config.parentStartTime) {
    throw new Error('parent start marker is required');
  }
  if (!isParentAlive(config.parentPid, config.parentStartTime)) {
    throw new Error('runner parent is not alive or its identity does not match');
  }

  // The guard is durable before any CLI is allowed to exist. A pre-existing
  // path is stale or hostile and is never replaced: directories, symlinks,
  // FIFOs and stale files must all block the launch.
  assertGuardPathAvailable(config.guardPath);
  if (!updateGuard({ state: 'starting' })) {
    throw new Error('process guard could not be persisted');
  }
  const validated = readValidatedStartingGuard(config.guardPath, guard);
  if (!validated.ok) {
    throw new Error(`process guard validation failed: ${validated.error}`);
  }

  // Close the crash window between the guard write and spawn: if the runner
  // died in the meantime, do not create a CLI at all.
  if (!isParentAlive(config.parentPid, config.parentStartTime)) {
    updateGuard({
      state: 'terminated',
      treeConfirmedGone: true,
      detail: 'runner exited after the guard was written and before the CLI was created',
    });
    cleanupIsolation();
    process.exit(0);
  }

  appendLog('guard ready; creating CLI');
  try {
    child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
  } catch (error) {
    updateGuard({
      state: 'failed',
      treeConfirmedGone: true,
      detail: `CLI spawn threw before a process existed: ${errorMessage(error)}`,
    });
    cleanupIsolation();
    process.exit(FAILED_BEFORE_CLI_EXIT);
  }

  child.once('error', (error) => {
    if (!child?.pid) {
      void failBeforeCli(`CLI spawn failed before a process existed: ${errorMessage(error)}`);
      return;
    }
    void terminateTree('cli-error', null, null, true);
  });
  child.once('close', (code, signal) => {
    void onCliClosed(code, signal);
  });

  if (!child.pid) {
    // Node exposes no PID only when the process was never created.
    await failBeforeCli('CLI spawn did not expose a PID');
    return;
  }

  // The CLI now owns the inherited stdio handles. Closing the supervisor's
  // copies makes EPIPE observable to the runner when the CLI closes stdin and
  // ensures stdout EOF follows the CLI, not this supervisor.
  closeSupervisorStdio();

  const cliStartTime = waitForProcessStartTimeSync(child.pid, 2000);
  const runningGuardPersisted = updateGuard({
    state: 'running',
    cliPid: child.pid,
    cliStartTime,
    detail: null,
  });
  if (!runningGuardPersisted) {
    // A CLI without durable recovery evidence must not be left running as if
    // the launch had succeeded. The tree cleanup below remains authoritative.
    await terminateTree('guard-write-failed', null, null, true);
    return;
  }
  appendLog(
    `CLI ${child.pid} started (isolation=${guard.isolation}, pgid=${guard.processGroupId ?? 'n/a'})`,
  );

  parentTimer = setInterval(() => {
    if (!isParentAlive(config.parentPid, config.parentStartTime)) {
      void terminateTree('runner-exited', null, null, true);
    }
  }, PARENT_POLL_MS);
  parentTimer.unref?.();

  controlTimer = setInterval(() => {
    const action = consumeControl();
    if (action) {
      void terminateTree(`control:${action}`, null, null, action === 'force');
    }
  }, CONTROL_POLL_MS);
  controlTimer.unref?.();

  process.once('SIGTERM', () => {
    void terminateTree('SIGTERM', null, 'SIGTERM', true);
  });
  process.once('SIGINT', () => {
    void terminateTree('SIGINT', null, 'SIGINT', true);
  });
}

async function failBeforeCli(detail: string): Promise<void> {
  if (finished) return;
  finished = true;
  updateGuard({
    state: 'failed',
    treeConfirmedGone: true,
    detail,
  });
  stopTimers();
  cleanupIsolation();
  process.exit(FAILED_BEFORE_CLI_EXIT);
}

async function onCliClosed(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  if (finished) return;
  appendLog(`CLI closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
  await terminateTree('cli-exited', code, signal, true);
}

async function terminateTree(
  reason: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  force: boolean,
): Promise<void> {
  if (finished) return;
  if (terminating) return;
  terminating = true;
  appendLog(`terminating protected tree: ${reason} force=${force}`);
  updateGuard({
    state: 'terminating',
    detail: reason,
  });

  const confirmed = await eliminateTree(force);
  const terminalState: ProcessGuardState = reason === 'cli-exited' ? 'exited' : 'terminated';
  updateGuard({
    state: confirmed ? terminalState : 'unconfirmed',
    treeConfirmedGone: confirmed,
    exitCode,
    signal,
    detail: confirmed ? reason : `${reason}; protected tree could not be confirmed empty`,
  });

  if (!confirmed) {
    // Keep this supervisor (and its guard) alive so the tree remains tracked.
    // Recovery will see `unconfirmed` and must not finalize the journal.
    terminating = false;
    appendLog('tree termination was not confirmed; supervisor stays alive for recovery');
    return;
  }

  finished = true;
  stopTimers();
  cleanupIsolation();
  appendLog(`tree confirmed gone; exiting with ${exitCode ?? 0}`);
  process.exit(exitCode ?? 0);
}

async function eliminateTree(force: boolean): Promise<boolean> {
  const deadline = Date.now() + TREE_CONFIRM_TIMEOUT_MS;
  let gracefulDeadline = force ? Date.now() : Date.now() + GRACEFUL_WAIT_MS;

  while (Date.now() < deadline) {
    const listed = listProtectedMembers();
    if (listed === null) {
      // An enumeration failure is not an empty tree. Keep waiting; if the OS
      // never lets us enumerate, report unconfirmed rather than finalizing.
      await delay(50);
      continue;
    }
    const members = listed.filter((pid) => pid !== process.pid);
    if (members.length === 0) return true;

    const useForce = force || Date.now() >= gracefulDeadline;
    for (const pid of members) {
      try {
        process.kill(pid, useForce ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // The member may have exited between enumeration and signalling.
      }
    }
    if (!useForce) {
      await delay(100);
      continue;
    }
    gracefulDeadline = Date.now();
    await delay(50);
  }
  const listed = listProtectedMembers();
  return listed !== null && listed.filter((pid) => pid !== process.pid).length === 0;
}

function listProtectedMembers(): number[] | null {
  if (guard.isolation === 'linux-cgroup' && guard.cgroupPath) {
    const members = readCgroupMembersSync(guard.cgroupPath);
    if (members !== null) return members;
  }
  return listProcessGroupMembersSync(guard.processGroupId);
}

function installIsolation(): {
  kind: ProcessGuardIsolation;
  installed: boolean;
  cgroupPath: string | null;
} {
  if (process.platform === 'linux') {
    const cgroupPath = `/sys/fs/cgroup/haft-runner/${sanitize(config.launchToken)}`;
    try {
      mkdirSync(dirname(cgroupPath), { recursive: true });
      mkdirSync(cgroupPath, { recursive: false });
      writeFileSync(`${cgroupPath}/cgroup.procs`, `${process.pid}\n`, 'utf8');
      return { kind: 'linux-cgroup', installed: true, cgroupPath };
    } catch (error) {
      appendLog(`cgroup unavailable, falling back to process group: ${errorMessage(error)}`);
      try {
        rmSync(cgroupPath, { recursive: false, force: true });
      } catch {
        // Best effort.
      }
    }
  }
  return {
    kind: 'posix-group',
    installed: processGroupId !== null,
    cgroupPath: null,
  };
}

function cleanupIsolation(): void {
  if (guard.isolation !== 'linux-cgroup' || !guard.cgroupPath) return;
  try {
    const members = readCgroupMembersSync(guard.cgroupPath);
    if (members && members.every((pid) => pid === process.pid)) {
      writeFileSync('/sys/fs/cgroup/cgroup.procs', `${process.pid}\n`, 'utf8');
    }
    rmdirSync(guard.cgroupPath);
  } catch {
    // A non-empty or already-removed cgroup is recovery evidence; leave it.
  }
}

function readCgroupMembersSync(cgroupPath: string): number[] | null {
  try {
    const raw = readFileSync(`${cgroupPath}/cgroup.procs`, 'utf8');
    return raw
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return null;
  }
}

function listProcessGroupMembersSync(pgid: number | null): number[] | null {
  if (!pgid) return null;
  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return null;
    }
    const members: number[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = readLinuxStat(Number(entry));
      if (stat && stat.state !== 'Z' && stat.state !== 'X' && stat.processGroupId === pgid) {
        members.push(Number(entry));
      }
    }
    return members;
  }
  try {
    const raw = execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const pid = Number(line);
        return Number.isInteger(pid) && pid > 0 ? [pid] : [];
      });
  } catch {
    return null;
  }
}

function readProcessStartTime(pid: number): string | null {
  if (process.platform === 'linux') return readLinuxStat(pid)?.startTime ?? null;
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw || null;
  } catch {
    return null;
  }
}

function readProcessGroupId(pid: number): number | null {
  if (process.platform === 'linux') return readLinuxStat(pid)?.processGroupId ?? null;
  try {
    const raw = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const pgid = Number(raw);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

function readLinuxStat(
  pid: number,
): { state: string; processGroupId: number; startTime: string } | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const state = fields[0] ?? '';
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isInteger(processGroupId) || !startTime) return null;
    return { state, processGroupId, startTime };
  } catch {
    return null;
  }
}

function isParentAlive(parentPid: number, parentStartTime: string): boolean {
  if (process.platform === 'linux') {
    // The runner is the supervisor's direct parent. Reparenting to init (or a
    // subreaper) is immediate proof that the runner died.
    if (process.ppid !== parentPid) return false;
    const stat = readLinuxStat(parentPid);
    if (!stat) return false;
    if (stat.state === 'Z' || stat.state === 'X') return false;
    return sameStartTime(stat.startTime, parentStartTime);
  }
  try {
    process.kill(parentPid, 0);
    return process.ppid === parentPid;
  } catch {
    return false;
  }
}

function consumeControl(): 'force' | 'graceful' | null {
  if (!existsSync(config.controlPath)) return null;
  try {
    const raw = readFileSync(config.controlPath, 'utf8').trim();
    rmSync(config.controlPath, { force: true });
    if (raw === 'force' || raw === 'graceful') return raw;
    return 'force';
  } catch {
    return null;
  }
}

function updateGuard(patch: Partial<ProcessGuardRecord>): boolean {
  Object.assign(guard, patch, { updatedAt: new Date().toISOString() });
  const temporary = `${config.guardPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    mkdirSync(dirname(config.guardPath), { recursive: true });
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(guard, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, config.guardPath);
    return true;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The original persistence error remains authoritative.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Cleanup is best effort.
    }
    appendLog(`could not persist guard: ${errorMessage(error)}`);
    return false;
  }
}

function appendLog(message: string): void {
  try {
    appendFileSync(`${config.guardPath}.log`, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Logging is diagnostic only.
  }
}

function closeSupervisorStdio(): void {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    try {
      stream.destroy();
    } catch {
      // The CLI holds its own inherited handles.
    }
  }
}

function stopTimers(): void {
  if (parentTimer) {
    clearInterval(parentTimer);
    parentTimer = null;
  }
  if (controlTimer) {
    clearInterval(controlTimer);
    controlTimer = null;
  }
}

function waitForProcessStartTimeSync(pid: number, timeoutMs: number): string | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startTime = readProcessStartTime(pid);
    if (startTime) return startTime;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return null;
}

function parseConfig(argv: string[]): SupervisorConfig {
  const separator = argv.indexOf('--');
  const head = separator >= 0 ? argv.slice(0, separator) : argv;
  const command = separator >= 0 ? argv[separator + 1] : '';
  const args = separator >= 0 ? argv.slice(separator + 2) : [];
  const values = new Map<string, string>();
  for (let index = 0; index < head.length; index += 1) {
    const key = head[index];
    if (!key?.startsWith('--')) continue;
    const value = head[index + 1];
    if (value === undefined) continue;
    values.set(key, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`missing required supervisor argument ${name}`);
    return value;
  };
  if (!command) throw new Error('missing CLI command after --');
  return {
    guardPath: required('--guard'),
    controlPath: required('--control'),
    executionId: required('--execution-id'),
    launchToken: required('--launch-token'),
    parentPid: Number(required('--parent-pid')),
    parentStartTime: required('--parent-start'),
    cwd: values.get('--cwd') || process.cwd(),
    command,
    args,
  };
}

function sameStartTime(left: string, right: string): boolean {
  if (left === right) return true;
  // Linux uses numeric clock ticks; they must match exactly.
  if (/^\d+$/.test(left) || /^\d+$/.test(right)) return false;
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) {
    return Math.abs(leftDate - rightDate) <= 2;
  }
  return false;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'execution';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
