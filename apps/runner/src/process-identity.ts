import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { runProcess } from './process-utils';

/**
 * OS process identity used for crash recovery.
 *
 * A PID alone is not a safe identity: operating systems reuse PIDs. The runner
 * therefore records the process start time (and, where available, the process
 * group and command line) in the journal, and only terminates an orphan when
 * the live process still matches that identity.
 */
export interface ProcessIdentity {
  pid: number;
  parentPid: number | null;
  processGroupId: number | null;
  /**
   * Stable, platform-native start marker.
   *
   * - Linux: `/proc/<pid>/stat` field 22 (clock ticks since boot).
   * - Windows: ISO-8601 UTC creation time.
   * - Other POSIX: the `lstart` column from `ps`.
   */
  startTime: string;
  commandLine: string | null;
}

export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return inspectWindowsProcess(pid);
  if (process.platform === 'linux') {
    const fromProc = await inspectLinuxProcess(pid);
    if (fromProc) return fromProc;
  }
  return inspectPsProcess(pid);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Waits until the process is gone, polling `kill(pid, 0)`.
 *
 * Returns `true` when the process exited before the timeout. It deliberately
 * does not treat "still alive" as success; callers must report incomplete
 * cleanup.
 */
export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(pollMs);
  }
  return !isProcessAlive(pid);
}

/**
 * Terminates a process tree by root PID.
 *
 * Windows uses `taskkill /T /F`, which is the only reliable tree kill for
 * `.cmd` shims that spawn a Node child. POSIX runners spawn the CLI as its own
 * process group, so a negative PID signal reaches the whole tree.
 */
export async function terminateProcessTree(pid: number, force = true): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    await runQuietly('taskkill', ['/pid', String(pid), '/T', '/F'], 10_000);
    try {
      process.kill(pid);
    } catch {
      // The process may already have exited.
    }
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited or the group may not exist.
    }
  }
}

async function inspectWindowsProcess(pid: number): Promise<ProcessIdentity | null> {
  const script =
    "$ErrorActionPreference='Stop'; " +
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
    'if ($null -eq $p) { exit 0 }; ' +
    '[pscustomobject]@{ pid = [int]$p.ProcessId; ' +
    'parentPid = [int]$p.ParentProcessId; ' +
    'processGroupId = [int]$p.ProcessId; ' +
    "startTime = $p.CreationDate.ToUniversalTime().ToString('o'); " +
    'commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress';
  let result;
  try {
    result = await runProcess(
      process.platform === 'win32' ? 'powershell.exe' : 'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
    );
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const output = result.stdout.trim();
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as {
      pid?: unknown;
      parentPid?: unknown;
      processGroupId?: unknown;
      startTime?: unknown;
      commandLine?: unknown;
    };
    const startTime = typeof parsed.startTime === 'string' ? parsed.startTime.trim() : '';
    if (!startTime) return null;
    return {
      pid,
      parentPid: toInteger(parsed.parentPid),
      processGroupId: toInteger(parsed.processGroupId) ?? pid,
      startTime,
      commandLine:
        typeof parsed.commandLine === 'string' && parsed.commandLine.trim()
          ? parsed.commandLine
          : null,
    };
  } catch {
    return null;
  }
}

async function inspectLinuxProcess(pid: number): Promise<ProcessIdentity | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state); field 22 (starttime) is fields[19].
  const startTime = fields[19];
  if (!startTime) return null;
  const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8')
    .then((value) =>
      value
        .split('\0')
        .filter((part) => part.length > 0)
        .join(' ') || null,
    )
    .catch(() => null);
  return {
    pid,
    parentPid: toInteger(fields[1]),
    processGroupId: toInteger(fields[2]),
    startTime,
    commandLine,
  };
}

async function inspectPsProcess(pid: number): Promise<ProcessIdentity | null> {
  let result;
  try {
    result = await runProcess(
      'ps',
      ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', String(pid)],
      { timeoutMs: 5000, maxOutputBytes: 64 * 1024 },
    );
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const line = result.stdout.trim();
  if (!line) return null;
  const match = line.match(
    /^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/,
  );
  if (!match) return null;
  return {
    pid: Number(match[1]),
    parentPid: toInteger(match[2]),
    processGroupId: toInteger(match[3]),
    startTime: match[4] as string,
    commandLine: match[5]?.trim() || null,
  };
}

function toInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function runQuietly(binary: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    let child;
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore cleanup failures.
      }
      resolvePromise();
    }, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
