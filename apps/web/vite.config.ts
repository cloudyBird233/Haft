import { join } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const reportDir = process.env.CI_TEST_REPORT_DIR;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      css: false,
      globals: true,
      ...(reportDir
        ? {
            reporters: [
              'default',
              ['json', { outputFile: join(reportDir, 'web.json') }],
              ['junit', { outputFile: join(reportDir, 'web-junit.xml') }],
            ],
          }
        : {}),
    },
  };
});
