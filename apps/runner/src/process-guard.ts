import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProcessIdentity } from './process-identity';
import { isProcessAlive, terminateProcessTree } from './process-identity';

/**
 * Durable process-tree guard owned by the per-execution supervisor.
 *
 * The guard is written by the supervisor *before* the CLI is created. It is
 * therefore the earliest durable evidence Recovery can use when the runner
 * dies between spawning the supervisor and persisting the CLI PID.
 */
export type ProcessGuardIsolation = 'windows-job' | 'linux-cgroup' | 'posix-group';

export type ProcessGuardState =
  | 'starting'
  | 'running'
  | 'terminating'
  | 'exited'
  | 'terminated'
  | 'failed'
  | 'unconfirmed';

export interface ProcessGuardRecord {
  version: 1;
  executionId: string;
  launchToken: string;
  parentPid: number;
  supervisorPid: number;
  supervisorStartTime: string;
  processGroupId: number | null;
  cgroupPath: string | null;
  cliPid: number | null;
  cliStartTime: string | null;
  isolation: ProcessGuardIsolation;
  state: ProcessGuardState;
  /** True only after the isolation mechanism was successfully installed. */
  jobCreated: boolean;
  /** True only when the supervisor itself verified the whole tree is gone. */
  treeConfirmedGone: boolean;
  exitCode: number | null;
  signal: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GuardReadResult =
  | { kind: 'ok'; guard: ProcessGuardRecord; path: string }
  | { kind: 'missing'; path: string }
  | { kind: 'invalid'; path: string; error: string };

export interface IdentityProbe {
  role: 'supervisor' | 'cli';
  pid: number;
  recordedStartTime: string | null;
  status: 'live-matching' | 'gone' | 'mismatch' | 'unverified';
  identity: ProcessIdentity | null;
}

export interface TreeVerification {
  confirmed: boolean;
  reason: string;
  identityMismatch: boolean;
  supervisor: IdentityProbe | null;
  cli: IdentityProbe | null;
  groupMemberCount: number;
  cgroupMemberCount: number;
}

export interface TreeTerminationResult extends TreeVerification {
  requested: boolean;
  /** True when a kill was actually issued (or a control request was written). */
  killIssued: boolean;
}

export interface GuardVerificationDependencies {
  inspectProcess(pid: number): Promise<ProcessIdentity | null>;
  terminateProcessTree(pid: number): Promise<void>;
  waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
}

export interface GuardTerminationOptions {
  /** How long to wait for the supervisor to confirm its own cleanup. */
  supervisorConfirmMs?: number;
  /** How long to wait for OS-level verification after a fallback tree kill. */
  verifyTimeoutMs?: number;
  /** Test seam: alternate taskkill binary for failure injection. */
  taskkillBinary?: string;
  /** False requests a graceful stop first; confirmation is still authoritative. */
  force?: boolean;
  /** Re-reads the guard so a supervisor-confirmed state is observed. */
  readGuard?: () => Promise<ProcessGuardRecord | null>;
}

const DEFAULT_SUPERVISOR_CONFIRM_MS = 4_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 6_000;
const KNOWN_STATES: ProcessGuardState[] = [
  'starting',
  'running',
  'terminating',
  'exited',
  'terminated',
  'failed',
  'unconfirmed',
];
const KNOWN_ISOLATIONS: ProcessGuardIsolation[] = [
  'windows-job',
  'linux-cgroup',
  'posix-group',
];

export async function readProcessGuard(guardPath: string): Promise<GuardReadResult> {
  let raw: string;
  try {
    raw = await readFile(guardPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing', path: guardPath };
    }
    return {
      kind: 'invalid',
      path: guardPath,
      error: `Could not read process guard: ${errorMessage(error)}`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'invalid',
      path: guardPath,
      error: `Process guard is not valid JSON: ${errorMessage(error)}`,
    };
  }
  if (!isProcessGuardRecord(value)) {
    return {
      kind: 'invalid',
      path: guardPath,
      error: 'Process guard failed validation',
    };
  }
  return { kind: 'ok', guard: value, path: guardPath };
}

export function isProcessGuardRecord(value: unknown): value is ProcessGuardRecord {
  if (!value || typeof value !== 'object') return false;
  const guard = value as Partial<ProcessGuardRecord>;
  return Boolean(
    guard.version === 1 &&
    typeof guard.executionId === 'string' &&
    guard.executionId.length > 0 &&
    typeof guard.launchToken === 'string' &&
    guard.launchToken.length > 0 &&
    positiveInteger(guard.parentPid) &&
    positiveInteger(guard.supervisorPid) &&
    typeof guard.supervisorStartTime === 'string' &&
    guard.supervisorStartTime.length > 0 &&
    (guard.processGroupId === null || positiveInteger(guard.processGroupId)) &&
    (guard.cgroupPath === null || typeof guard.cgroupPath === 'string') &&
    (guard.cliPid === null || positiveInteger(guard.cliPid)) &&
    (guard.cliStartTime === null || typeof guard.cliStartTime === 'string') &&
    KNOWN_ISOLATIONS.includes(guard.isolation as ProcessGuardIsolation) &&
    KNOWN_STATES.includes(guard.state as ProcessGuardState) &&
    typeof guard.jobCreated === 'boolean' &&
    typeof guard.treeConfirmedGone === 'boolean' &&
    (guard.exitCode === null || typeof guard.exitCode === 'number') &&
    (guard.signal === null || typeof guard.signal === 'string') &&
    (guard.detail === null || typeof guard.detail === 'string') &&
    typeof guard.createdAt === 'string' &&
    typeof guard.updatedAt === 'string',
  );
}

/** Guard files must stay inside the recovery root; a journal cannot point anywhere else. */
export function isGuardPathInsideRecoveryRoot(recoveryRoot: string, guardPath: string): boolean {
  const root = resolve(recoveryRoot);
  const guardRoot = resolve(root, 'guards');
  const target = resolve(guardPath);
  const relativePath = relative(guardRoot, target);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath) &&
    !relativePath.startsWith(`..${sep}`)
  );
}

export function guardPathFor(
  recoveryRoot: string,
  executionId: string,
  launchToken: string,
): string {
  return join(recoveryRoot, 'guards', `${sanitize(executionId)}.${sanitize(launchToken)}.guard.json`);
}

export function guardControlPathFor(guardPath: string): string {
  return `${guardPath}.control`;
}

export async function writeGuardControl(controlPath: string, force: boolean): Promise<void> {
  const target = `${controlPath}.${process.pid}.tmp`;
  await mkdir(dirname(controlPath), { recursive: true });
  await writeFile(target, force ? 'force\n' : 'graceful\n', 'utf8');
  await rename(target, controlPath);
}

/**
 * Probes the identities recorded in a guard. A live PID is only considered
 * matching when its recorded start marker is present and equal. A live PID
 * with a different marker is a reused PID; a live PID we cannot inspect is
 * "unverified", never "gone".
 */
export async function probeGuardIdentities(
  guard: ProcessGuardRecord,
  inspectProcess: (pid: number) => Promise<ProcessIdentity | null>,
): Promise<{ supervisor: IdentityProbe; cli: IdentityProbe | null }> {
  const supervisor = await probeIdentity(
    'supervisor',
    guard.supervisorPid,
    guard.supervisorStartTime,
    inspectProcess,
  );
  const cli =
    guard.cliPid === null
      ? null
      : await probeIdentity('cli', guard.cliPid, guard.cliStartTime, inspectProcess);
  return { supervisor, cli };
}

async function probeIdentity(
  role: 'supervisor' | 'cli',
  pid: number,
  recordedStartTime: string | null,
  inspectProcess: (pid: number) => Promise<ProcessIdentity | null>,
): Promise<IdentityProbe> {
  let identity: ProcessIdentity | null;
  try {
    identity = await inspectProcess(pid);
  } catch {
    return {
      role,
      pid,
      recordedStartTime,
      status: 'unverified',
      identity: null,
    };
  }
  if (!identity) {
    // A failed inspection is not proof of absence. If the OS still says the
    // PID exists, keep the identity unverified so recovery blocks instead of
    // finalizing the journal behind a live process.
    if (isProcessAlive(pid)) {
      return { role, pid, recordedStartTime, status: 'unverified', identity: null };
    }
    return { role, pid, recordedStartTime, status: 'gone', identity: null };
  }
  if (!recordedStartTime || !identity.startTime) {
    return { role, pid, recordedStartTime, status: 'unverified', identity };
  }
  if (!sameStartTime(recordedStartTime, identity.startTime)) {
    return { role, pid, recordedStartTime, status: 'mismatch', identity };
  }
  return {
    role,
    pid,
    recordedStartTime,
    status: 'live-matching',
    identity,
  };
}

/**
 * Verifies the *whole* protected tree, not just the root PID.
 *
 * - Windows: the supervisor's Job Object has kill-on-close. Once the
 *   supervisor is gone the kernel has closed the job, so no job member can
 *   survive. Known CLI identity is also checked.
 * - Linux: the cgroup (preferred) or process group is enumerated. A non-empty
 *   group whose members no longer match any recorded identity is treated as
 *   an unrelated/reused group and is never killed.
 */
export async function verifyGuardedTree(
  guard: ProcessGuardRecord,
  dependencies: Pick<GuardVerificationDependencies, 'inspectProcess'>,
): Promise<TreeVerification> {
  const { supervisor, cli } = await probeGuardIdentities(guard, dependencies.inspectProcess);
  const supervisorLive = supervisor.status === 'live-matching';
  const cliLive = cli?.status === 'live-matching';
  const identityMismatch =
    supervisor.status === 'mismatch' ||
    supervisor.status === 'unverified' ||
    cli?.status === 'mismatch' ||
    cli?.status === 'unverified' ||
    false;

  let groupMemberCount = 0;
  let cgroupMemberCount = 0;
  let groupKnown = true;
  let groupUnknownReason: string | null = null;

  if (guard.isolation === 'linux-cgroup' && guard.cgroupPath) {
    const members = await readCgroupMembers(guard.cgroupPath);
    if (!members.ok) {
      groupKnown = false;
      groupUnknownReason = `Could not read cgroup ${guard.cgroupPath}: ${
        members.error ?? 'unknown error'
      }`;
    } else if (members.exists) {
      cgroupMemberCount = members.pids.length;
      groupKnown = cgroupMemberCount === 0;
    } else {
      // The supervisor removes the cgroup only after verifying it is empty.
      groupKnown = guard.treeConfirmedGone;
      if (!groupKnown) {
        groupUnknownReason = `The protected cgroup ${guard.cgroupPath} no longer exists but its emptiness was never confirmed`;
      }
    }
  } else if (guard.isolation === 'linux-cgroup') {
    groupKnown = false;
    groupUnknownReason = 'The guard does not record the private cgroup it was placed in';
  } else if (guard.isolation === 'posix-group' && guard.processGroupId) {
    const scan = await scanProcessGroupMembers(guard.processGroupId);
    groupMemberCount = scan.members.length;
    if (!scan.ok) {
      groupKnown = false;
      groupUnknownReason = `Could not enumerate process group ${guard.processGroupId}: ${
        scan.error ?? 'unknown error'
      }`;
    } else if (scan.members.length === 0) {
      groupKnown = true;
    } else {
      const matchesKnown = scan.members.some(
        (member) =>
          (guard.supervisorPid === member.pid &&
            sameStartTime(guard.supervisorStartTime, member.startTime)) ||
          (guard.cliPid === member.pid &&
            guard.cliStartTime !== null &&
            sameStartTime(guard.cliStartTime, member.startTime)),
      );
      // A non-empty group with no recorded member is not evidence of our
      // process: it may be a reused PGID. Never treat it as confirmed.
      groupKnown = false;
      if (!matchesKnown) {
        return {
          confirmed: false,
          reason: `Process group ${guard.processGroupId} still has members but none match the recorded execution identity`,
          identityMismatch: true,
          supervisor,
          cli,
          groupMemberCount,
          cgroupMemberCount,
        };
      }
    }
  } else if (guard.isolation === 'posix-group') {
    groupKnown = false;
    groupUnknownReason = 'The guard does not record the protected process group';
  }

  if (identityMismatch) {
    return {
      confirmed: false,
      reason: `A live PID no longer matches the recorded process identity (${guard.supervisorPid}${
        guard.cliPid ? `/${guard.cliPid}` : ''
      })`,
      identityMismatch: true,
      supervisor,
      cli,
      groupMemberCount,
      cgroupMemberCount,
    };
  }

  if (guard.isolation === 'windows-job') {
    if (supervisorLive) {
      return {
        confirmed: false,
        reason: `Supervisor PID ${guard.supervisorPid} is still alive`,
        identityMismatch: false,
        supervisor,
        cli,
        groupMemberCount,
        cgroupMemberCount,
      };
    }
    if (cliLive) {
      return {
        confirmed: false,
        reason: `CLI PID ${guard.cliPid} is still alive after the supervisor exited`,
        identityMismatch: false,
        supervisor,
        cli,
        groupMemberCount,
        cgroupMemberCount,
      };
    }
    if (!guard.jobCreated) {
      return {
        confirmed: false,
        reason: 'The supervisor never confirmed that the Job Object was installed',
        identityMismatch: false,
        supervisor,
        cli,
        groupMemberCount,
        cgroupMemberCount,
      };
    }
    // Job handle lived in the supervisor. Its exit closed the handle and the
    // kernel terminated every member; descendants cannot break away because
    // JOB_OBJECT_LIMIT_BREAKAWAY_OK was never granted.
    return {
      confirmed: true,
      reason: 'The supervisor exited; the kill-on-close Job Object no longer has members',
      identityMismatch: false,
      supervisor,
      cli,
      groupMemberCount,
      cgroupMemberCount,
    };
  }

  if (supervisorLive || cliLive) {
    return {
      confirmed: false,
      reason: `Protected processes are still alive (supervisor=${supervisor.status}, cli=${
        cli?.status ?? 'absent'
      })`,
      identityMismatch: false,
      supervisor,
      cli,
      groupMemberCount,
      cgroupMemberCount,
    };
  }

  if (!groupKnown) {
    return {
      confirmed: false,
      reason: groupUnknownReason ?? 'The protected cgroup/process group is not empty',
      identityMismatch: false,
      supervisor,
      cli,
      groupMemberCount,
      cgroupMemberCount,
    };
  }

  if (guard.cliPid === null && guard.state === 'starting') {
    // The supervisor writes the guard before it is allowed to create the CLI.
    return {
      confirmed: true,
      reason: 'The supervisor exited before it was allowed to create the CLI',
      identityMismatch: false,
      supervisor,
      cli,
      groupMemberCount,
      cgroupMemberCount,
    };
  }

  if (!guard.treeConfirmedGone && guard.state === 'unconfirmed') {
    return {
      confirmed: false,
      reason: guard.detail ?? 'The supervisor reported unconfirmed tree termination',
      identityMismatch: false,
      supervisor,
      cli,
      groupMemberCount,
      cgroupMemberCount,
    };
  }

  return {
    confirmed: true,
    reason: 'The protected process group/cgroup is empty and no recorded process is alive',
    identityMismatch: false,
    supervisor,
    cli,
    groupMemberCount,
    cgroupMemberCount,
  };
}

/**
 * Requests termination through the supervisor first, then falls back to an
 * OS-level tree kill. Returns `confirmed` only after the whole protected tree
 * is verified gone. Identity mismatches never kill anything.
 */
export async function terminateGuardedTree(
  guard: ProcessGuardRecord,
  controlPath: string | null,
  dependencies: GuardVerificationDependencies,
  options: GuardTerminationOptions = {},
): Promise<TreeTerminationResult> {
  const supervisorConfirmMs = options.supervisorConfirmMs ?? DEFAULT_SUPERVISOR_CONFIRM_MS;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  let latestGuard = guard;
  const currentGuard = async (): Promise<ProcessGuardRecord> => {
    if (!options.readGuard) return latestGuard;
    const next = await options.readGuard();
    if (next) latestGuard = next;
    return latestGuard;
  };

  const initial = await verifyGuardedTree(await currentGuard(), dependencies);
  if (initial.confirmed) {
    return { ...initial, requested: false, killIssued: false };
  }
  if (initial.identityMismatch) {
    return { ...initial, requested: true, killIssued: false };
  }

  let killIssued = false;
  if (controlPath) {
    try {
      await writeGuardControl(controlPath, options.force !== false);
      killIssued = true;
    } catch {
      // Fall through to the OS-level kill; the verification below remains the
      // only authority for whether termination is confirmed.
    }
  }

  const afterRequest = await waitForGuardGone(
    await currentGuard(),
    dependencies,
    supervisorConfirmMs,
    currentGuard,
  );
  if (afterRequest.confirmed) {
    return { ...afterRequest, requested: true, killIssued };
  }
  if (afterRequest.identityMismatch) {
    return { ...afterRequest, requested: true, killIssued };
  }

  const fallback = await killProtectedTreeFallback(
    await currentGuard(),
    dependencies,
    options.taskkillBinary,
  );
  killIssued = killIssued || fallback.killIssued;
  if (!fallback.allowed) {
    return {
      ...fallback.verification,
      requested: true,
      killIssued,
    };
  }

  const final = await waitForGuardGone(
    await currentGuard(),
    dependencies,
    verifyTimeoutMs,
    currentGuard,
  );
  return { ...final, requested: true, killIssued };
}

async function waitForGuardGone(
  guard: ProcessGuardRecord,
  dependencies: Pick<GuardVerificationDependencies, 'inspectProcess'>,
  timeoutMs: number,
  readGuard?: () => Promise<ProcessGuardRecord>,
): Promise<TreeVerification> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let current = guard;
  let latest = await verifyGuardedTree(current, dependencies);
  while (!latest.confirmed && !latest.identityMismatch && Date.now() < deadline) {
    await delay(50);
    if (readGuard) current = await readGuard();
    latest = await verifyGuardedTree(current, dependencies);
  }
  return latest;
}

async function killProtectedTreeFallback(
  guard: ProcessGuardRecord,
  dependencies: Pick<GuardVerificationDependencies, 'inspectProcess'>,
  taskkillBinary?: string,
): Promise<{
  allowed: boolean;
  killIssued: boolean;
  verification: TreeVerification;
}> {
  const current = await verifyGuardedTree(guard, dependencies);
  if (current.confirmed || current.identityMismatch) {
    return { allowed: false, killIssued: false, verification: current };
  }

  if (guard.isolation === 'windows-job') {
    if (current.supervisor?.status === 'live-matching') {
      const result = await terminateProcessTree(guard.supervisorPid, true, taskkillBinary);
      if (!result.confirmed) {
        return {
          allowed: false,
          killIssued: true,
          verification: {
            ...current,
            reason:
              result.error ??
              `taskkill did not confirm supervisor PID ${guard.supervisorPid} exited`,
          },
        };
      }
      return { allowed: true, killIssued: true, verification: current };
    }
    if (current.cli?.status === 'live-matching' && guard.cliPid !== null) {
      const result = await terminateProcessTree(guard.cliPid, true, taskkillBinary);
      if (!result.confirmed) {
        return {
          allowed: false,
          killIssued: true,
          verification: {
            ...current,
            reason: result.error ?? `taskkill did not confirm CLI PID ${guard.cliPid} exited`,
          },
        };
      }
      return { allowed: true, killIssued: true, verification: current };
    }
    return { allowed: false, killIssued: false, verification: current };
  }

  if (guard.isolation === 'linux-cgroup' && guard.cgroupPath) {
    const members = await readCgroupMembers(guard.cgroupPath);
    if (!members.ok) {
      return {
        allowed: false,
        killIssued: false,
        verification: {
          ...current,
          reason: `Could not read cgroup ${guard.cgroupPath}: ${members.error ?? 'unknown error'}`,
        },
      };
    }
    if (members.exists && members.pids.length > 0) {
      try {
        await writeFile(join(guard.cgroupPath, 'cgroup.kill'), '1\n', 'utf8');
        return { allowed: true, killIssued: true, verification: current };
      } catch (error) {
        return {
          allowed: false,
          killIssued: true,
          verification: {
            ...current,
            reason: `Could not write cgroup.kill for ${guard.cgroupPath}: ${errorMessage(error)}`,
          },
        };
      }
    }
    return { allowed: false, killIssued: false, verification: current };
  }

  if (guard.isolation === 'posix-group' && guard.processGroupId) {
    const scan = await scanProcessGroupMembers(guard.processGroupId);
    if (!scan.ok) {
      return {
        allowed: false,
        killIssued: false,
        verification: {
          ...current,
          reason: `Could not enumerate process group ${guard.processGroupId}: ${
            scan.error ?? 'unknown error'
          }`,
        },
      };
    }
    const matchesKnown = scan.members.some(
      (member) =>
        (member.pid === guard.supervisorPid &&
          sameStartTime(member.startTime, guard.supervisorStartTime)) ||
        (member.pid === guard.cliPid &&
          guard.cliStartTime !== null &&
          sameStartTime(member.startTime, guard.cliStartTime)),
    );
    if (!matchesKnown) {
      return {
        allowed: false,
        killIssued: false,
        verification: {
          ...current,
          identityMismatch: true,
          reason: `Process group ${guard.processGroupId} has no member matching the recorded identity`,
        },
      };
    }
    try {
      process.kill(-guard.processGroupId, 'SIGKILL');
      return { allowed: true, killIssued: true, verification: current };
    } catch (error) {
      return {
        allowed: false,
        killIssued: true,
        verification: {
          ...current,
          reason: `Could not kill process group ${guard.processGroupId}: ${errorMessage(error)}`,
        },
      };
    }
  }

  return { allowed: false, killIssued: false, verification: current };
}

export interface ProcessGroupMember {
  pid: number;
  startTime: string;
}

export interface ProcessGroupScan {
  /** False when the OS refused the enumeration; never treat that as an empty group. */
  ok: boolean;
  members: ProcessGroupMember[];
  error: string | null;
}

/**
 * Enumerates every member of a POSIX process group. Linux uses /proc; other
 * POSIX systems fall back to `ps`. A scan error is reported explicitly so a
 * caller can never mistake incomplete evidence for an empty group.
 */
export async function scanProcessGroupMembers(pgid: number): Promise<ProcessGroupScan> {
  if (!positiveInteger(pgid)) {
    return { ok: false, members: [], error: `Invalid process group ${pgid}` };
  }
  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = await readdir('/proc');
    } catch (error) {
      return {
        ok: false,
        members: [],
        error: `Could not enumerate /proc: ${errorMessage(error)}`,
      };
    }
    const members: ProcessGroupMember[] = [];
    await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          const pid = Number(entry);
          const stat = await readLinuxStat(pid);
          if (!stat || stat.processGroupId !== pgid) return;
          members.push({ pid, startTime: stat.startTime });
        }),
    );
    return {
      ok: true,
      members: members.sort((left, right) => left.pid - right.pid),
      error: null,
    };
  }
  if (process.platform === 'win32') {
    return { ok: false, members: [], error: 'POSIX process groups do not exist on Windows' };
  }
  try {
    const { runProcess } = await import('./process-utils');
    const result = await runProcess('ps', ['-o', 'pid=,pgid=,lstart=', '-g', String(pgid)], {
      timeoutMs: 5000,
      maxOutputBytes: 256 * 1024,
    });
    if (result.code !== 0) {
      return {
        ok: false,
        members: [],
        error: `ps exited with code ${result.code ?? result.signal ?? 'unknown'}`,
      };
    }
    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const members = lines.flatMap((line) => {
      const match = line.match(/^(\d+)\s+\d+\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), startTime: match[2] as string }];
    });
    if (lines.length > 0 && members.length === 0) {
      return { ok: false, members: [], error: 'Could not parse ps process-group output' };
    }
    return { ok: true, members, error: null };
  } catch (error) {
    return {
      ok: false,
      members: [],
      error: `Could not run ps: ${errorMessage(error)}`,
    };
  }
}

/** Diagnostic wrapper. Safety decisions must use `scanProcessGroupMembers`. */
export async function listProcessGroupMembers(pgid: number): Promise<ProcessGroupMember[]> {
  return (await scanProcessGroupMembers(pgid)).members;
}

async function readLinuxStat(
  pid: number,
): Promise<{ processGroupId: number; startTime: string } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isInteger(processGroupId) || !startTime) return null;
    return { processGroupId, startTime };
  } catch {
    return null;
  }
}

export interface CgroupMemberScan {
  exists: boolean;
  /** False when the OS refused the read; never treat that as an empty cgroup. */
  ok: boolean;
  pids: number[];
  error: string | null;
}

export async function readCgroupMembers(cgroupPath: string): Promise<CgroupMemberScan> {
  if (!isSafeCgroupPath(cgroupPath)) {
    return {
      exists: false,
      ok: false,
      pids: [],
      error: `Refusing unsafe cgroup path ${cgroupPath}`,
    };
  }
  let raw: string;
  try {
    raw = await readFile(join(cgroupPath, 'cgroup.procs'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, ok: true, pids: [], error: null };
    }
    return {
      exists: true,
      ok: false,
      pids: [],
      error: `Could not read ${join(cgroupPath, 'cgroup.procs')}: ${errorMessage(error)}`,
    };
  }
  const pids = raw
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return { exists: true, ok: true, pids, error: null };
}

export function isSafeCgroupPath(path: string): boolean {
  return process.platform === 'linux' && path.startsWith('/sys/fs/cgroup/');
}

/** Normalizes platform start markers so a 1ms clock representation difference is not a mismatch. */
export function sameStartTime(left: string, right: string): boolean {
  if (left === right) return true;
  // Linux reports integer clock ticks; those must match exactly. Parsing them
  // as dates would treat unrelated processes as the same identity.
  if (/^\d+$/.test(left) || /^\d+$/.test(right)) return false;
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) {
    return Math.abs(leftDate - rightDate) <= 2;
  }
  return false;
}

export function isPidAlive(pid: number): boolean {
  return isProcessAlive(pid);
}

/** Reads the live cgroup/process-group membership for diagnostics. */
export async function describeGuardMembership(
  guard: ProcessGuardRecord,
): Promise<{ groupPids: number[]; cgroupPids: number[] }> {
  const groupPids =
    guard.isolation === 'posix-group' && guard.processGroupId
      ? (await listProcessGroupMembers(guard.processGroupId)).map((member) => member.pid)
      : [];
  const cgroupPids =
    guard.isolation === 'linux-cgroup' && guard.cgroupPath
      ? (await readCgroupMembers(guard.cgroupPath)).pids
      : [];
  return { groupPids, cgroupPids };
}

export async function removeGuardArtifacts(guardPath: string): Promise<void> {
  await rm(guardPath, { force: true }).catch(() => undefined);
  await rm(`${guardPath}.control`, { force: true }).catch(() => undefined);
}

export async function ensureGuardDirectory(guardPath: string): Promise<void> {
  await mkdir(resolve(guardPath, '..'), { recursive: true });
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
  return sanitized || 'guard';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
