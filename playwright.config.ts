import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3101';
const WEB_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5174';
const RUNNER_HEALTH_PORT = process.env.E2E_RUNNER_HEALTH_PORT ?? '3199';
const RUNNER_HEALTH_URL =
  process.env.E2E_RUNNER_HEALTH_URL ?? `http://127.0.0.1:${RUNNER_HEALTH_PORT}`;
const RUNNER_BOOTSTRAP_TOKEN =
  process.env.E2E_RUNNER_BOOTSTRAP_TOKEN ?? 'e2e-runner-bootstrap-token';
const E2E_REPOSITORY_ROOT = join(process.cwd(), 'test-results', 'e2e-repository');
const CI_TEST_REPORT_DIR = process.env.CI_TEST_REPORT_DIR;

/**
 * Keep screenshots comparable across machines by preferring the Chromium
 * revision used to capture the committed visual baseline. An explicit
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE wins; otherwise use the cached revision when
 * present, then let Playwright pick its configured browser.
 */
function resolveChromiumExecutable(): string | undefined {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (configured && existsSync(configured)) {
    return configured;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const cached = join(
      localAppData,
      'ms-playwright',
      'chromium-1228',
      'chrome-win64',
      'chrome.exe',
    );
    if (existsSync(cached)) {
      return cached;
    }
  }
  return undefined;
}

const executablePath = resolveChromiumExecutable();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 12_000,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ...(CI_TEST_REPORT_DIR
      ? [
          ['json', { outputFile: join(CI_TEST_REPORT_DIR, 'playwright.json') }],
          ['junit', { outputFile: join(CI_TEST_REPORT_DIR, 'playwright-junit.xml') }],
        ]
      : []),
  ],
  outputDir: 'test-results',
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
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
        },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @raft-lite/api start:e2e',
      url: `${API_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        E2E_TEST_MODE: 'true',
      },
    },
    {
      command: 'pnpm --filter @raft-lite/web dev:e2e',
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    // Deterministic Fake Runner: proves the Socket.IO protocol, server-side
    // persistence and the UI loop without invoking a real model or CLI.
    {
      command: 'node tests/e2e/prepare-repository.mjs && pnpm --filter @raft-lite/runner start',
      url: `${RUNNER_HEALTH_URL}/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        HAFT_SERVER_URL: API_URL,
        HAFT_RUNNER_ID: 'runner_e2e',
        HAFT_RUNNER_COMPUTER_ID: 'computer_local',
        HAFT_RUNNER_BOOTSTRAP_TOKEN: RUNNER_BOOTSTRAP_TOKEN,
        HAFT_RUNNER_TOKEN_FILE: join(process.cwd(), 'test-results', '.runner', 'runner-e2e.json'),
        HAFT_RUNNER_RECOVERY_ROOT: join(process.cwd(), 'test-results', '.runner', 'recovery'),
        HAFT_RUNNER_MODE: 'fake',
        HAFT_RUNNER_PROJECTS: JSON.stringify({ project_demo: process.cwd() }),
        HAFT_RUNNER_ALLOWED_ROOTS: JSON.stringify([E2E_REPOSITORY_ROOT]),
        HAFT_RUNNER_HEALTH_PORT: RUNNER_HEALTH_PORT,
      },
    },
  ],
});
