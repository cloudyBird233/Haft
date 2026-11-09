import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RUNNER_RUNTIMES, type RunnerRuntimeType } from '@raft-lite/contracts';

export type RunnerMode = 'fake' | 'real';

export interface RunnerConfig {
  serverUrl: string;
  runnerId: string;
  computerId: string;
  bootstrapToken: string | null;
  tokenFile: string;
  mode: RunnerMode;
  fakeRuntimes: RunnerRuntimeType[];
  realRuntimes: RunnerRuntimeType[];
  cliPaths: Partial<Record<RunnerRuntimeType, string>>;
  cliModels: Partial<Record<RunnerRuntimeType, string>>;
  gitBinary: string;
  worktreeRoot: string;
  keepWorktrees: boolean;
  recoveryRoot: string;
  shutdownGraceMs: number;
  cliTimeoutMs: number;
  allowAutoApprove: boolean;
  projectPaths: Record<string, string>;
  /**
   * Directories that may contain a real Git repository. Repository validation
   * fails closed when this list is empty.
   */
  allowedRepositoryRoots: string[];
  stepMs: number;
  healthPort: number;
  maxConcurrentExecutions: number;
  runnerVersion: string;
  platform: string;
  architecture: string;
}

const HELP = `Haft Agent Runner

Usage: pnpm --filter @raft-lite/runner start -- [options]

Options:
  --server <url>             API base URL (default http://127.0.0.1:3001)
  --runner-id <id>           Stable runner id (default runner_local)
  --computer-id <id>         Computer id registered in the API (default computer_local)
  --bootstrap-token <token>  One-time pairing token
  --token-file <path>        Where the issued runner token is cached
  --mode <fake|real|codex|opencode>  fake runs deterministic steps; real/codex/opencode run a real CLI (default fake)
  --project <id=path>        Project mapping; repeat for multiple projects
  --allowed-root <path>      Repository root allowed for real Git validation; repeat to add roots
  --codex-bin <path>         Explicit Codex CLI executable (default: codex from PATH)
  --opencode-bin <path>      Explicit OpenCode CLI executable (default: opencode from PATH)
  --codex-model <model>      Optional Codex model passed to the CLI
  --opencode-model <model>   Optional OpenCode model passed to the CLI
  --step-ms <ms>             Fake runner step duration (default 250)
  --health-port <port>       Local health endpoint port; 0 disables it (default 0)
  --max-concurrent <n>       Maximum concurrent executions (default 1)
  --help                     Show this help

Environment equivalents use the HAFT_ prefix:
  HAFT_SERVER_URL, HAFT_RUNNER_ID, HAFT_RUNNER_COMPUTER_ID,
  HAFT_RUNNER_BOOTSTRAP_TOKEN, HAFT_RUNNER_TOKEN_FILE, HAFT_RUNNER_MODE,
  HAFT_RUNNER_FAKE_RUNTIMES, HAFT_RUNNER_REAL_RUNTIMES,
  HAFT_CODEX_BIN, HAFT_OPENCODE_BIN, HAFT_CODEX_MODEL, HAFT_OPENCODE_MODEL,
  HAFT_RUNNER_PROJECTS (JSON map), HAFT_RUNNER_PROJECT_ID,
  HAFT_RUNNER_ALLOWED_ROOTS (JSON array),
  HAFT_RUNNER_WORKSPACE_ROOT, HAFT_RUNNER_WORKTREE_ROOT, HAFT_GIT_BIN,
  HAFT_RUNNER_KEEP_WORKTREES, HAFT_RUNNER_RECOVERY_ROOT,
  HAFT_RUNNER_SHUTDOWN_GRACE_MS, HAFT_RUNNER_CLI_TIMEOUT_MS,
  HAFT_RUNNER_ALLOW_AUTO_APPROVE, HAFT_RUNNER_STEP_MS,
  HAFT_RUNNER_HEALTH_PORT, HAFT_RUNNER_MAX_CONCURRENT.

Real CLI mode always uses the Codex workspace-write sandbox. OpenCode --auto
is only passed when HAFT_RUNNER_ALLOW_AUTO_APPROVE=1 is configured explicitly.
`;

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): RunnerConfig {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      server: { type: 'string' },
      'runner-id': { type: 'string' },
      'computer-id': { type: 'string' },
      'bootstrap-token': { type: 'string' },
      'token-file': { type: 'string' },
      mode: { type: 'string' },
      project: { type: 'string', multiple: true },
      'allowed-root': { type: 'string', multiple: true },
      'codex-bin': { type: 'string' },
      'opencode-bin': { type: 'string' },
      'codex-model': { type: 'string' },
      'opencode-model': { type: 'string' },
      'step-ms': { type: 'string' },
      'health-port': { type: 'string' },
      'max-concurrent': { type: 'string' },
      help: { type: 'boolean' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const serverUrl = trimSlash(values.server ?? env.HAFT_SERVER_URL ?? 'http://127.0.0.1:3001');
  const runnerId = values['runner-id'] ?? env.HAFT_RUNNER_ID ?? 'runner_local';
  const computerId = values['computer-id'] ?? env.HAFT_RUNNER_COMPUTER_ID ?? 'computer_local';
  const bootstrapToken =
    values['bootstrap-token'] ?? env.HAFT_RUNNER_BOOTSTRAP_TOKEN?.trim() ?? null;
  const tokenFile = expandHome(
    values['token-file'] ??
      env.HAFT_RUNNER_TOKEN_FILE ??
      join(homedir(), '.haft', `runner-${runnerId}.json`),
  );

  const requestedMode = (values.mode ?? env.HAFT_RUNNER_MODE ?? 'fake').trim().toLowerCase();
  if (
    requestedMode !== 'fake' &&
    requestedMode !== 'real' &&
    requestedMode !== 'codex' &&
    requestedMode !== 'opencode'
  ) {
    throw new Error(
      `Unsupported runner mode "${requestedMode}"; expected fake, real, codex or opencode`,
    );
  }
  const mode: RunnerMode = requestedMode === 'fake' ? 'fake' : 'real';

  const fakeRuntimes = parseRuntimeList(
    env.HAFT_RUNNER_FAKE_RUNTIMES ?? 'codex,opencode',
    'HAFT_RUNNER_FAKE_RUNTIMES',
  );
  const realRuntimes =
    requestedMode === 'codex'
      ? (['codex'] as RunnerRuntimeType[])
      : requestedMode === 'opencode'
        ? (['opencode'] as RunnerRuntimeType[])
        : parseRuntimeList(
            env.HAFT_RUNNER_REAL_RUNTIMES ?? 'codex,opencode',
            'HAFT_RUNNER_REAL_RUNTIMES',
          );
  const cliPaths: Partial<Record<RunnerRuntimeType, string>> = {};
  const codexBin = values['codex-bin'] ?? env.HAFT_CODEX_BIN;
  const opencodeBin = values['opencode-bin'] ?? env.HAFT_OPENCODE_BIN;
  if (codexBin?.trim()) cliPaths.codex = codexBin.trim();
  if (opencodeBin?.trim()) cliPaths.opencode = opencodeBin.trim();
  const cliModels: Partial<Record<RunnerRuntimeType, string>> = {};
  const codexModel = values['codex-model'] ?? env.HAFT_CODEX_MODEL;
  const opencodeModel = values['opencode-model'] ?? env.HAFT_OPENCODE_MODEL;
  if (codexModel?.trim()) cliModels.codex = codexModel.trim();
  if (opencodeModel?.trim()) cliModels.opencode = opencodeModel.trim();
  const projectPaths = parseProjectPaths(
    env.HAFT_RUNNER_PROJECTS,
    env.HAFT_RUNNER_PROJECT_ID ?? 'project_demo',
    env.HAFT_RUNNER_WORKSPACE_ROOT ?? env.INIT_CWD ?? process.cwd(),
  );
  for (const project of values.project ?? []) {
    const separator = project.indexOf('=');
    if (separator <= 0) {
      throw new Error(`--project must be <projectId>=<absolutePath>, received "${project}"`);
    }
    const projectId = project.slice(0, separator).trim();
    const projectPath = resolve(project.slice(separator + 1).trim());
    projectPaths[projectId] = projectPath;
  }
  const allowedRepositoryRoots = parseAllowedRoots(env.HAFT_RUNNER_ALLOWED_ROOTS);
  for (const root of values['allowed-root'] ?? []) {
    if (!root.trim()) {
      throw new Error('--allowed-root must not be empty');
    }
    allowedRepositoryRoots.push(resolve(root.trim()));
  }

  return {
    serverUrl,
    runnerId,
    computerId,
    bootstrapToken: bootstrapToken || null,
    tokenFile,
    mode,
    fakeRuntimes,
    realRuntimes,
    cliPaths,
    cliModels,
    gitBinary: env.HAFT_GIT_BIN?.trim() || 'git',
    worktreeRoot: expandHome(
      env.HAFT_RUNNER_WORKTREE_ROOT ?? join(homedir(), '.haft', 'worktrees'),
    ),
    keepWorktrees: env.HAFT_RUNNER_KEEP_WORKTREES !== '0',
    recoveryRoot: expandHome(
      env.HAFT_RUNNER_RECOVERY_ROOT ?? join(homedir(), '.haft', 'recovery', runnerId),
    ),
    shutdownGraceMs: clampInt(
      env.HAFT_RUNNER_SHUTDOWN_GRACE_MS ?? '10000',
      1000,
      120_000,
      'shutdown-grace-ms',
    ),
    cliTimeoutMs: clampInt(
      env.HAFT_RUNNER_CLI_TIMEOUT_MS ?? String(30 * 60 * 1000),
      10_000,
      2 * 60 * 60 * 1000,
      'cli-timeout-ms',
    ),
    allowAutoApprove: env.HAFT_RUNNER_ALLOW_AUTO_APPROVE === '1',
    projectPaths,
    allowedRepositoryRoots: [...new Set(allowedRepositoryRoots)],
    stepMs: clampInt(values['step-ms'] ?? env.HAFT_RUNNER_STEP_MS ?? '250', 20, 10_000, 'step-ms'),
    healthPort: clampInt(
      values['health-port'] ?? env.HAFT_RUNNER_HEALTH_PORT ?? '0',
      0,
      65_535,
      'health-port',
    ),
    maxConcurrentExecutions: clampInt(
      values['max-concurrent'] ?? env.HAFT_RUNNER_MAX_CONCURRENT ?? '1',
      1,
      32,
      'max-concurrent',
    ),
    runnerVersion: '0.1.0',
    platform: process.platform,
    architecture: process.arch,
  };
}

function parseRuntimeList(value: string, name: string): RunnerRuntimeType[] {
  const selected = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const runtimes = selected.filter((item): item is RunnerRuntimeType =>
    (RUNNER_RUNTIMES as readonly string[]).includes(item),
  );
  if (runtimes.length === 0) {
    throw new Error(`${name} must include at least one of codex,opencode`);
  }
  return [...new Set(runtimes)];
}

function parseProjectPaths(
  raw: string | undefined,
  fallbackProjectId: string,
  fallbackRoot: string,
): Record<string, string> {
  if (!raw?.trim()) {
    return { [fallbackProjectId]: resolve(fallbackRoot) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('HAFT_RUNNER_PROJECTS must be a JSON object mapping project ids to paths');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HAFT_RUNNER_PROJECTS must be a JSON object mapping project ids to paths');
  }
  const result: Record<string, string> = {};
  for (const [projectId, projectPath] of Object.entries(parsed)) {
    if (typeof projectPath !== 'string' || !projectId.trim() || !projectPath.trim()) {
      throw new Error('HAFT_RUNNER_PROJECTS entries must be non-empty string paths');
    }
    result[projectId.trim()] = resolve(projectPath);
  }
  if (Object.keys(result).length === 0) {
    throw new Error('HAFT_RUNNER_PROJECTS must contain at least one project mapping');
  }
  return result;
}

function parseAllowedRoots(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('HAFT_RUNNER_ALLOWED_ROOTS must be a JSON array of directory paths');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('HAFT_RUNNER_ALLOWED_ROOTS must be a non-empty JSON array of directory paths');
  }
  return parsed.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('HAFT_RUNNER_ALLOWED_ROOTS entries must be non-empty string paths');
    }
    return resolve(entry.trim());
  });
}

function clampInt(raw: string, min: number, max: number, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export { HELP };
