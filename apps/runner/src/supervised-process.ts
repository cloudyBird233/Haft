import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProcessGuardRecord, TreeTerminationResult, TreeVerification } from './process-guard';
import {
  guardControlPathFor,
  guardPathFor,
  readProcessGuard,
  terminateGuardedTree,
  verifyGuardedTree,
} from './process-guard';
import { inspectProcess, terminateProcessTree, waitForProcessExit } from './process-identity';

/**
 * Launches a real CLI behind the per-execution supervisor.
 *
 * The returned ChildProcess is the supervisor. Its stdin/stdout/stderr are
 * inherited by the CLI, so the executor keeps the same streaming interface.
 * The supervisor is the protected root: its cgroup/process group/Job Object
 * contains the CLI and every descendant.
 */
export interface SupervisorLaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  executionId: string;
  launchToken: string;
  recoveryRoot: string;
}

export interface SupervisedProcess {
  child: ChildProcess;
  guardPath: string;
  controlPath: string;
  /** Resolves once the guard is durable and the CLI process has been created. */
  ready: Promise<ProcessGuardRecord>;
  terminate(force: boolean, timeoutMs?: number): Promise<TreeTerminationResult>;
  verifyTreeGone(timeoutMs?: number): Promise<TreeVerification>;
  currentGuard(): Promise<ProcessGuardRecord | null>;
}

interface SupervisorRuntime {
  command: string;
  prefixArgs: string[];
  kind: 'js' | 'ts' | 'windows-exe';
  /** Cwd used to resolve the supervisor's own loader (tsx); not the CLI cwd. */
  cwd: string | null;
}

const SUPERVISOR_READY_TIMEOUT_MS = 20_000;
/** Bounded cleanup attempt for a supervisor that never produced a usable guard. */
const UNREADY_SUPERVISOR_KILL_WAIT_MS = 2_000;

let runtimePromise: Promise<SupervisorRuntime> | null = null;
let parentIdentityPromise: Promise<{ pid: number; startTime: string }> | null = null;

export async function prepareProcessSupervisor(): Promise<void> {
  await resolveSupervisorRuntime();
}

export async function spawnSupervisedProcess(
  spec: SupervisorLaunchSpec,
): Promise<SupervisedProcess> {
  const runtime = await resolveSupervisorRuntime();
  const parent = await currentParentIdentity();
  const guardPath = guardPathFor(spec.recoveryRoot, spec.executionId, spec.launchToken);
  const controlPath = guardControlPathFor(guardPath);
  await mkdir(dirname(guardPath), { recursive: true });

  const args = [
    ...runtime.prefixArgs,
    '--guard',
    guardPath,
    '--control',
    controlPath,
    '--execution-id',
    spec.executionId,
    '--launch-token',
    spec.launchToken,
    '--parent-pid',
    String(parent.pid),
    '--parent-start',
    parent.startTime,
    '--cwd',
    spec.cwd,
    '--',
    spec.command,
    ...spec.args,
  ];

  const child = spawn(runtime.command, args, {
    // The supervisor is not the CLI. Give it a cwd where its own loader (for
    // example `tsx` in development) resolves, while `--cwd` tells it where the
    // CLI must actually run.
    cwd: runtime.cwd ?? spec.cwd,
    env: spec.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let latestGuard: ProcessGuardRecord | null = null;
  const ready = waitForGuardReady(child, guardPath, spec).then((guard) => {
    latestGuard = guard;
    return guard;
  });
  // The executor may not await ready before the supervisor fails (for example
  // when negotiation is still in progress). Keep the original rejection for
  // callers, but mark it handled so a fast supervisor failure can never become
  // an unhandled rejection that takes down the runner.
  void ready.catch(() => undefined);

  const currentGuard = async (): Promise<ProcessGuardRecord | null> => {
    const read = await readProcessGuard(guardPath);
    if (read.kind === 'ok') {
      latestGuard = read.guard;
      return read.guard;
    }
    return latestGuard;
  };

  const guardForOperation = async (
    waitMs = SUPERVISOR_READY_TIMEOUT_MS,
  ): Promise<{ guard: ProcessGuardRecord } | { guard: null; error: string }> => {
    const current = await currentGuard();
    if (current) return { guard: current };
    try {
      return { guard: await waitForReadyBounded(ready, waitMs) };
    } catch (error) {
      return {
        guard: null,
        error: `PROCESS_SUPERVISOR_NOT_READY: ${errorMessage(error)}`,
      };
    }
  };

  return {
    child,
    guardPath,
    controlPath,
    ready,
    async terminate(force: boolean, timeoutMs?: number): Promise<TreeTerminationResult> {
      const selected = await guardForOperation(timeoutMs ?? SUPERVISOR_READY_TIMEOUT_MS);
      if (!selected.guard) {
        // The supervisor never produced a readable guard. A verified tree kill
        // is impossible, so report unconfirmed and keep the journal active.
        // Still make one bounded, handle-based cleanup attempt so a stuck
        // supervisor cannot be left behind indefinitely.
        const killIssued = await killUnreadySupervisor(child);
        return unconfirmedTermination(selected.error, killIssued);
      }
      try {
        return await terminateGuardedTree(
          selected.guard,
          controlPath,
          {
            inspectProcess,
            terminateProcessTree: async (pid: number) => {
              const result = await terminateProcessTree(pid);
              if (!result.confirmed) {
                throw new Error(result.error ?? `Could not confirm PID ${pid} exited`);
              }
            },
            waitForProcessExit,
          },
          {
            force,
            supervisorConfirmMs: timeoutMs,
            verifyTimeoutMs: timeoutMs,
            readGuard: currentGuard,
          },
        );
      } catch (error) {
        return unconfirmedTermination(
          `PROCESS_TREE_NOT_CONFIRMED: termination threw: ${errorMessage(error)}`,
        );
      }
    },
    async verifyTreeGone(timeoutMs = 5_000): Promise<TreeVerification> {
      const selected = await guardForOperation(timeoutMs);
      if (!selected.guard) {
        return unconfirmedVerification(selected.error);
      }
      const deadline = Date.now() + Math.max(0, timeoutMs);
      let result = await verifyGuardedTree(selected.guard, { inspectProcess });
      while (!result.confirmed && !result.identityMismatch && Date.now() < deadline) {
        await delay(50);
        const refreshed = (await currentGuard()) ?? selected.guard;
        result = await verifyGuardedTree(refreshed, { inspectProcess });
      }
      return result;
    },
    currentGuard,
  };
}

/**
 * Resolves the runner's own PID identity before spawning the supervisor. This
 * is deliberately *before* any CLI exists; it is not used to establish process
 * protection. The supervisor compares it against the OS handle it opens so a
 * reused parent PID can never keep an orphan tree alive.
 */
async function currentParentIdentity(): Promise<{ pid: number; startTime: string }> {
  if (!parentIdentityPromise) {
    parentIdentityPromise = (async () => {
      const identity = await inspectProcess(process.pid);
      if (!identity?.startTime) {
        throw new Error(
          'PROCESS_SUPERVISOR_PARENT_IDENTITY_FAILED: the runner could not inspect its own process identity',
        );
      }
      return { pid: process.pid, startTime: identity.startTime };
    })().catch((error: unknown) => {
      parentIdentityPromise = null;
      throw error;
    });
  }
  return parentIdentityPromise;
}

function unconfirmedVerification(reason: string): TreeVerification {
  return {
    confirmed: false,
    reason,
    identityMismatch: false,
    supervisor: null,
    cli: null,
    groupMemberCount: 0,
    cgroupMemberCount: 0,
  };
}

function unconfirmedTermination(reason: string, killIssued = false): TreeTerminationResult {
  return {
    ...unconfirmedVerification(reason),
    requested: true,
    killIssued,
  };
}

/**
 * Bounded, handle-based cleanup for a supervisor that never produced a usable
 * guard. Killing the direct child is safe because Node owns that handle; the
 * result is deliberately still unconfirmed because the protected tree could not
 * be verified.
 */
async function killUnreadySupervisor(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  let cleanup = (): void => undefined;
  const exited = new Promise<void>((resolvePromise) => {
    const done = (): void => {
      cleanup();
      resolvePromise();
    };
    cleanup = (): void => {
      child.off('exit', done);
      child.off('close', done);
    };
    child.once('exit', done);
    child.once('close', done);
  });
  let killed: boolean;
  try {
    killed = child.kill('SIGKILL');
  } catch {
    cleanup();
    return false;
  }
  if (!killed) {
    cleanup();
    return false;
  }
  await Promise.race([exited, delay(UNREADY_SUPERVISOR_KILL_WAIT_MS)]);
  cleanup();
  return true;
}

/**
 * Exported for the supervisor-safety tests, which use a fake child and real
 * guard files to prove the ready contract without inventing a second
 * implementation.
 */
export async function waitForGuardReady(
  child: ChildProcess,
  guardPath: string,
  spec: SupervisorLaunchSpec,
  timeoutMs = SUPERVISOR_READY_TIMEOUT_MS,
): Promise<ProcessGuardRecord> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError = 'guard was not written';
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (error) => {
    // Without this listener an unstartable spawn would surface as an unhandled
    // EventEmitter error and take down the runner process.
    lastError = `supervisor spawn failed: ${errorMessage(error)}`;
    exited = true;
  });

  while (Date.now() < deadline) {
    const read = await readProcessGuard(guardPath);
    if (read.kind === 'ok') {
      if (
        read.guard.executionId !== spec.executionId ||
        read.guard.launchToken !== spec.launchToken ||
        read.guard.supervisorPid !== child.pid
      ) {
        lastError = 'guard identity does not match the spawned supervisor';
      } else if (read.guard.state === 'failed') {
        throw new Error(
          `PROCESS_SUPERVISOR_FAILED: ${
            read.guard.detail ?? 'the supervisor failed before creating the CLI'
          }`,
        );
      } else if (
        read.guard.state === 'running' ||
        read.guard.state === 'exited' ||
        read.guard.state === 'terminated' ||
        read.guard.state === 'unconfirmed'
      ) {
        return read.guard;
      }
    } else if (read.kind === 'invalid') {
      lastError = read.error;
    }

    if (exited) {
      const finalRead = await readProcessGuard(guardPath);
      if (finalRead.kind === 'ok' && finalRead.guard.state === 'failed') {
        throw new Error(
          `PROCESS_SUPERVISOR_FAILED: ${
            finalRead.guard.detail ?? 'the supervisor failed before creating the CLI'
          }`,
        );
      }
      throw new Error(
        `PROCESS_SUPERVISOR_EXITED: the supervisor exited before reporting a running CLI (${lastError})`,
      );
    }
    await delay(20);
  }
  throw new Error(`PROCESS_SUPERVISOR_TIMEOUT: ${lastError}`);
}

async function resolveSupervisorRuntime(): Promise<SupervisorRuntime> {
  if (!runtimePromise) {
    runtimePromise = resolveSupervisorRuntimeOnce().catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function resolveSupervisorRuntimeOnce(): Promise<SupervisorRuntime> {
  if (process.platform === 'win32') {
    return {
      command: await ensureWindowsSupervisor(),
      prefixArgs: [],
      kind: 'windows-exe',
      cwd: null,
    };
  }

  const candidates = supervisorScriptCandidates();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.endsWith('.js') || candidate.endsWith('.cjs')) {
      return {
        command: process.execPath,
        prefixArgs: [candidate],
        kind: 'js',
        cwd: dirname(candidate),
      };
    }
    if (candidate.endsWith('.ts')) {
      return {
        command: process.execPath,
        prefixArgs: ['--import', 'tsx', candidate],
        kind: 'ts',
        cwd: dirname(candidate),
      };
    }
  }
  throw new Error(
    'PROCESS_SUPERVISOR_UNAVAILABLE: could not locate the POSIX process supervisor script',
  );
}

function supervisorScriptCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.HAFT_PROCESS_SUPERVISOR) {
    candidates.push(process.env.HAFT_PROCESS_SUPERVISOR);
  }
  const moduleDirectory = currentModuleDirectory();
  if (moduleDirectory) {
    candidates.push(join(moduleDirectory, 'process-supervisor-child.js'));
    candidates.push(join(moduleDirectory, 'process-supervisor-child.ts'));
  }
  candidates.push(join(process.cwd(), 'src', 'process-supervisor-child.ts'));
  candidates.push(join(process.cwd(), 'apps', 'runner', 'src', 'process-supervisor-child.ts'));
  return [...new Set(candidates)];
}

function currentModuleDirectory(): string | null {
  try {
    // CommonJS production build (tsup) and tsx both expose __dirname.
    return typeof __dirname === 'string' ? __dirname : null;
  } catch {
    return null;
  }
}

async function ensureWindowsSupervisor(): Promise<string> {
  const source = windowsSupervisorSource();
  const sourceContents = await readFile(source, 'utf8');
  const hash = createHash('sha256').update(sourceContents).digest('hex').slice(0, 16);
  const root = join(
    process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'),
    'Haft',
    'runner-bin',
  );
  const target = join(root, `haft-process-supervisor-${hash}.exe`);
  try {
    const info = await stat(target);
    if (info.isFile() && info.size > 0) return target;
  } catch {
    // Compile below.
  }

  const csc = await findCsc();
  await mkdir(root, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp.exe`;
  const { runProcess } = await import('./process-utils');
  const result = await runProcess(
    csc,
    [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      '/warn:4',
      `/out:${temporary}`,
      source,
    ],
    { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 },
  );
  if (result.code !== 0) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(
      `PROCESS_SUPERVISOR_COMPILE_FAILED: csc exited with ${
        result.code ?? result.signal ?? 'unknown'
      }: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`,
    );
  }
  await rename(temporary, target);
  return target;
}

function windowsSupervisorSource(): string {
  const moduleDirectory = currentModuleDirectory();
  const candidates = [
    ...(moduleDirectory
      ? [join(moduleDirectory, '..', 'native', 'windows-process-supervisor.cs')]
      : []),
    join(process.cwd(), 'native', 'windows-process-supervisor.cs'),
    join(process.cwd(), 'apps', 'runner', 'native', 'windows-process-supervisor.cs'),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) {
    throw new Error(
      'PROCESS_SUPERVISOR_UNAVAILABLE: could not locate native/windows-process-supervisor.cs',
    );
  }
  return source;
}

async function findCsc(): Promise<string> {
  if (process.env.HAFT_CSC?.trim()) {
    return process.env.HAFT_CSC.trim();
  }
  const windir = process.env.WINDIR?.trim() || 'C:\\Windows';
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'PROCESS_SUPERVISOR_UNAVAILABLE: csc.exe was not found; a Windows Job Object supervisor is required for real executions',
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Bounds how long cleanup may wait for a supervisor to publish its guard.
 * `ready` is shared with all callers and is never cancelled; this only bounds
 * the local operation so shutdown cannot hang on a supervisor that is stuck
 * before writing its guard.
 */
async function waitForReadyBounded(
  ready: Promise<ProcessGuardRecord>,
  timeoutMs: number,
): Promise<ProcessGuardRecord> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the supervisor guard was not readable within ${timeoutMs} ms`)),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
