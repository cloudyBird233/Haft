import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const reportDir = process.env.CI_TEST_REPORT_DIR;

export default defineConfig({
  test: {
    ...(reportDir
      ? {
          reporters: [
            'default',
            ['json', { outputFile: join(reportDir, 'contracts.json') }],
            ['junit', { outputFile: join(reportDir, 'contracts-junit.xml') }],
          ],
        }
      : {}),
  },
});
