import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const reportDir = process.env.CI_TEST_REPORT_DIR;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    testTimeout: 15_000,
    /**
     * Real-OS tests in this package start supervisors and CLIs and probe process
     * identity through the platform (`powershell.exe` on Windows). Running every
     * file in parallel on a many-core host starves those OS calls; a failed
     * identity probe is deliberately fail-closed, so the runner then refuses to
     * finalize a tree it cannot verify and an otherwise-correct test fails.
     * Capping file-level parallelism keeps the suite measuring the runner
     * instead of the host's process-spawn throughput.
     */
    maxWorkers: 4,
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
