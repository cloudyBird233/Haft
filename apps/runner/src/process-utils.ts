import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Process helpers for runner-side execution.
 *
 * Every CLI and Git invocation goes through spawn with an argument array and
 * `shell: false`. Prompts and task text are written to stdin, never spliced
 * into a command line, so shell metacharacters cannot become commands.
 */

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export function runProcess(
  binary: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxBytes) return current;
      return (current + chunk.toString('utf8')).slice(0, maxBytes);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void terminateProcess(child, true);
          }, options.timeoutMs)
        : null;

    const finish = (result: ProcessRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Terminates the CLI process and its children.
 *
 * POSIX processes are spawned as their own process group so cancelling the
 * group also stops helper processes. Windows uses taskkill /T, which is the
 * only reliable way to stop a CLI that has spawned child processes.
 */
export async function terminateProcess(child: ChildProcess, force = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    await runQuietly('taskkill', ['/pid', String(pid), '/T', '/F'], 10_000);
    try {
      child.kill();
    } catch {
      // The process may already have exited between the two calls.
    }
    return;
  }

  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // The process may already have exited.
    }
  }
}

async function runQuietly(binary: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    let child: ChildProcess;
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

export interface ResolvedExecutable {
  path: string | null;
  searched: string[];
  error: string | null;
}

export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedExecutable> {
  const trimmed = command.trim();
  if (!trimmed) {
    return { path: null, searched: [], error: 'Executable name is empty' };
  }

  const looksLikePath =
    isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\');
  if (looksLikePath) {
    const candidate = resolve(trimmed);
    if (!(await isFile(candidate))) {
      return { path: null, searched: [candidate], error: `${trimmed} was not found` };
    }
    return resolvePlatformExecutable(candidate);
  }

  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  let located: ProcessRunResult;
  try {
    located = await runProcess(locator, [trimmed], { timeoutMs: 5000, env });
  } catch (error) {
    return {
      path: null,
      searched: [],
      error: `Could not search PATH for ${trimmed}: ${errorMessage(error)}`,
    };
  }
  if (located.code !== 0) {
    return {
      path: null,
      searched: [],
      error: `${trimmed} was not found on PATH`,
    };
  }

  const candidates = located.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const shimErrors: string[] = [];

  for (const candidate of candidates) {
    if (!(await isFile(candidate))) continue;

    if (process.platform === 'win32') {
      if (/\.(cmd|bat)$/i.test(candidate)) {
        const shim = await resolveWindowsShim(candidate);
        if (shim) {
          return { path: shim, searched: candidates, error: null };
        }
        shimErrors.push(
          `Could not find the executable referenced by ${candidate}; set an explicit CLI path.`,
        );
        continue;
      }
      if (!/\.(exe|com)$/i.test(candidate)) {
        continue;
      }
      return { path: resolve(candidate), searched: candidates, error: null };
    }

    if (await isExecutable(candidate)) {
      return { path: resolve(candidate), searched: candidates, error: null };
    }
  }

  return {
    path: null,
    searched: candidates,
    error:
      shimErrors[0] ??
      `${trimmed} was found on PATH but no directly executable file was available; set an explicit CLI path.`,
  };
}

async function resolvePlatformExecutable(candidate: string): Promise<ResolvedExecutable> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
    const shim = await resolveWindowsShim(candidate);
    if (!shim) {
      return {
        path: null,
        searched: [candidate],
        error: `Could not find the executable referenced by ${candidate}; set an explicit CLI path.`,
      };
    }
    return { path: shim, searched: [candidate], error: null };
  }
  return { path: candidate, searched: [candidate], error: null };
}

/**
 * npm installs Windows shims as .cmd wrappers. Node cannot spawn .cmd files
 * without a shell, so read the wrapper and use the .exe it points at.
 */
async function resolveWindowsShim(shimPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(shimPath, 'utf8');
  } catch {
    return null;
  }
  const base = dirname(shimPath);
  const candidates = new Set<string>();

  for (const match of raw.matchAll(/"([^"]+\.exe)"|'([^']+\.exe)'/gi)) {
    const value = match[1] ?? match[2];
    if (value) candidates.add(value);
  }
  if (candidates.size === 0) {
    for (const token of raw.split(/\s+/)) {
      if (/\.exe$/i.test(token)) candidates.add(token.replace(/^["']|["']$/g, ''));
    }
  }

  for (const rawCandidate of candidates) {
    const expanded = rawCandidate
      .replace(/%dp0%/gi, `${base}\\`)
      .replace(/%~dp0%/gi, `${base}\\`)
      .replace(/\$basedir/g, base);
    const candidate = resolve(expanded);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Remove every runner secret and Haft-specific variable from the child
 * environment. The runner token is persisted to its own file and is never
 * inherited by codex/opencode (or any process they spawn).
 */
export function buildCliEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('HAFT_')) continue;
    if (key.startsWith('E2E_RUNNER_')) continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  return env;
}

async function isFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
