import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3101';
const WEB_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5174';

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
  ],
});
