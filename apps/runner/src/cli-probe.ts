import { RUNTIME_LABELS, type RunnerRuntimeCapability, type RunnerRuntimeType } from '@raft-lite/contracts';
import type { RunnerConfig } from './config';
import {
  buildCliEnvironment,
  errorMessage,
  resolveExecutable,
  runProcess,
  type ProcessRunResult,
} from './process-utils';

const PROBE_TIMEOUT_MS = 20_000;

/**
 * Capability probes run once when the runner starts. They only execute fixed
 * version/auth subcommands with a sanitized environment; they never include
 * task text or runner secrets.
 */
export async function probeRuntimeCapabilities(
  config: Pick<RunnerConfig, 'realRuntimes' | 'cliPaths'>,
): Promise<RunnerRuntimeCapability[]> {
  return Promise.all(config.realRuntimes.map((runtime) => probeRuntime(runtime, config)));
}

export async function probeRuntime(
  runtime: RunnerRuntimeType,
  config: Pick<RunnerConfig, 'cliPaths'>,
): Promise<RunnerRuntimeCapability> {
  const label = RUNTIME_LABELS[runtime];
  const command = config.cliPaths[runtime] ?? runtime;
  const resolved = await resolveExecutable(command);
  if (!resolved.path) {
    return {
      runtime,
      installed: false,
      version: null,
      authenticated: false,
      message: resolved.error ?? `${label} CLI was not found`,
    };
  }

  let versionResult: ProcessRunResult;
  try {
    versionResult = await runProcess(resolved.path, ['--version'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: buildCliEnvironment(),
    });
  } catch (error) {
    return {
      runtime,
      installed: false,
      version: null,
      authenticated: false,
      message: `${label} CLI could not be started: ${errorMessage(error)}`,
    };
  }

  if (versionResult.code !== 0) {
    return {
      runtime,
      installed: true,
      version: null,
      authenticated: false,
      message: `${label} CLI --version failed: ${firstLine(versionResult.stderr || versionResult.stdout)}`,
    };
  }

  const version = firstLine(versionResult.stdout || versionResult.stderr) || null;
  const auth = await probeAuthentication(runtime, resolved.path);
  return {
    runtime,
    installed: true,
    version,
    authenticated: auth.authenticated,
    message: auth.message,
  };
}

export interface AuthProbeResult {
  authenticated: boolean;
  message: string | null;
}

export async function probeAuthentication(
  runtime: RunnerRuntimeType,
  executable: string,
): Promise<AuthProbeResult> {
  if (runtime === 'codex') {
    return probeCodexAuth(executable);
  }
  return probeOpencodeAuth(executable);
}

async function probeCodexAuth(executable: string): Promise<AuthProbeResult> {
  try {
    const result = await runProcess(executable, ['login', 'status'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: buildCliEnvironment(),
    });
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
    const loggedIn =
      result.code === 0 && /logged in/i.test(output) && !/not logged in/i.test(output);
    if (loggedIn) {
      return { authenticated: true, message: null };
    }
    return {
      authenticated: false,
      message: output || 'Codex CLI is not authenticated; run "codex login" on the runner host.',
    };
  } catch (error) {
    return {
      authenticated: false,
      message: `Could not check Codex authentication: ${errorMessage(error)}`,
    };
  }
}

async function probeOpencodeAuth(executable: string): Promise<AuthProbeResult> {
  try {
    const result = await runProcess(executable, ['auth', 'list'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: buildCliEnvironment(),
    });
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
    const hasCredential =
      result.code === 0 && /\bstored\b/i.test(output) && !/no credentials/i.test(output);
    if (hasCredential) {
      return { authenticated: true, message: null };
    }

    // Older CLI builds may not expose "auth list". A successful model listing
    // is a conservative fallback: it proves a provider is configured without
    // invoking a model.
    const models = await runProcess(executable, ['models'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: buildCliEnvironment(),
    });
    if (models.code === 0 && models.stdout.trim().length > 0) {
      return { authenticated: true, message: null };
    }
    return {
      authenticated: false,
      message:
        output || 'OpenCode CLI has no stored credentials; run "opencode auth login" on the runner host.',
    };
  } catch (error) {
    return {
      authenticated: false,
      message: `Could not check OpenCode authentication: ${errorMessage(error)}`,
    };
  }
}

function firstLine(value: string): string {
  const line = stripAnsi(value)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  return (line ?? '').slice(0, 120);
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
