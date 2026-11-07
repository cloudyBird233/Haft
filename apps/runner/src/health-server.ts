import { createServer, type Server } from 'node:http';
import type { RunnerClient } from './runner-client';

/**
 * Optional loopback-only health endpoint used by local process supervisors and
 * Playwright's webServer readiness check. It exposes no tokens or prompts.
 */
export function startHealthServer(
  port: number,
  runnerId: string,
  client: RunnerClient,
): Server | null {
  if (port <= 0) {
    return null;
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || (request.url !== '/health' && request.url !== '/ready')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const connected = client.isConnected();
    const ready = request.url !== '/ready' || connected;
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: ready ? 'ok' : 'connecting',
        runnerId,
        mode: client.mode(),
        connected,
        activeExecutionIds: client.activeExecutionIds(),
        pendingLogCount: client.pendingLogCount(),
        timestamp: new Date().toISOString(),
      }),
    );
  });
  server.listen(port, '127.0.0.1');
  server.unref();
  return server;
}
