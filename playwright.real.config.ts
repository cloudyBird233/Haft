import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Completely separate opt-in suite for real Codex/OpenCode processes.
 *
 * It uses its own database, ports, token file, disposable Git repository and
 * worktree root, so installing or authenticating a CLI can never affect the
 * deterministic Fake Runner suite (`pnpm test:e2e`).
 */
const API_URL = process.env.REAL_E2E_API_URL ?? 'http://127.0.0.1:3201';
const WEB_URL = process.env.REAL_E2E_WEB_URL ?? 'http://127.0.0.1:5274';
const RUNNER_HEALTH_PORT = process.env.REAL_E2E_RUNNER_HEALTH_PORT ?? '3299';
const RUNNER_HEALTH_URL = `http://127.0.0.1:${RUNNER_HEALTH_PORT}`;
const RUNNER_BOOTSTRAP_TOKEN =
  process.env.REAL_E2E_RUNNER_BOOTSTRAP_TOKEN ?? 'real-e2e-runner-bootstrap-token';
const CI_TEST_REPORT_DIR = process.env.CI_TEST_REPORT_DIR;

const REAL_E2E_ROOT = join(process.cwd(), 'test-results', 'real-e2e');
const PROJECT_DIR = join(REAL_E2E_ROOT, 'workspace');
const WORKTREE_ROOT = join(REAL_E2E_ROOT, 'worktrees');
const RECOVERY_ROOT = join(REAL_E2E_ROOT, 'recovery');

const runnerEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HAFT_SERVER_URL: API_URL,
  HAFT_RUNNER_ID: 'runner_real_e2e',
  HAFT_RUNNER_COMPUTER_ID: 'computer_local',
  HAFT_RUNNER_BOOTSTRAP_TOKEN: RUNNER_BOOTSTRAP_TOKEN,
  HAFT_RUNNER_TOKEN_FILE: join(REAL_E2E_ROOT, '.runner', 'runner-real-e2e.json'),
  HAFT_RUNNER_MODE: 'real',
  HAFT_RUNNER_REAL_RUNTIMES: 'codex,opencode',
  HAFT_RUNNER_PROJECTS: JSON.stringify({ project_demo: PROJECT_DIR }),
  HAFT_RUNNER_ALLOWED_ROOTS: JSON.stringify([PROJECT_DIR]),
  HAFT_RUNNER_WORKTREE_ROOT: WORKTREE_ROOT,
  HAFT_RUNNER_KEEP_WORKTREES: '1',
  HAFT_RUNNER_RECOVERY_ROOT: RECOVERY_ROOT,
  HAFT_RUNNER_CLI_TIMEOUT_MS: '600000',
  HAFT_RUNNER_HEALTH_PORT: RUNNER_HEALTH_PORT,
  HAFT_RUNNER_MAX_CONCURRENT: '1',
  // Explicit opt-in for this trusted disposable fixture. Codex still uses its
  // workspace-write sandbox; only OpenCode receives --auto.
  HAFT_RUNNER_ALLOW_AUTO_APPROVE: '1',
};

if (process.env.HAFT_REAL_CODEX_MODEL) {
  runnerEnv.HAFT_CODEX_MODEL = process.env.HAFT_REAL_CODEX_MODEL;
}
if (process.env.HAFT_REAL_OPENCODE_MODEL) {
  runnerEnv.HAFT_OPENCODE_MODEL = process.env.HAFT_REAL_OPENCODE_MODEL;
}

export default defineConfig({
  testDir: './tests/e2e-real',
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ...(CI_TEST_REPORT_DIR
      ? [
          ['json', { outputFile: join(CI_TEST_REPORT_DIR, 'playwright.json') }],
          ['junit', { outputFile: join(CI_TEST_REPORT_DIR, 'playwright-junit.xml') }],
        ]
      : []),
  ],
  outputDir: 'test-results/real-e2e/playwright',
  use: {
    baseURL: WEB_URL,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: [
    {
      command: 'pnpm --filter @raft-lite/api start:real-e2e',
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        E2E_TEST_MODE: 'true',
      },
    },
    {
      command: 'pnpm --filter @raft-lite/web dev:real-e2e',
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...process.env,
        VITE_API_PROXY_TARGET: API_URL,
        VITE_SOCKET_URL: API_URL,
      },
    },
    {
      command: 'node tests/e2e-real/prepare-project.mjs && pnpm --filter @raft-lite/runner start',
      url: `${RUNNER_HEALTH_URL}/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: runnerEnv,
    },
  ],
});
