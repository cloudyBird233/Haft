import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const reportDir = process.env.CI_TEST_REPORT_DIR;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    testTimeout: 15_000,
    ...(reportDir
      ? {
          reporters: [
            'default',
            ['json', { outputFile: join(reportDir, 'runner.json') }],
            ['junit', { outputFile: join(reportDir, 'runner-junit.xml') }],
          ],
        }
      : {}),
  },
});
