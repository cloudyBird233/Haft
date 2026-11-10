import type { Server } from 'node:http';
import { loadConfig } from './config';
import { startHealthServer } from './health-server';
import { log } from './logger';
import { RepositoryPathPolicy } from './repository-policy';
import { RunnerClient } from './runner-client';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log('error', {
      eventType: 'runner.config_invalid',
      message: 'Runner configuration is invalid',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  let healthServer: Server | null = null;
  const policy = new RepositoryPathPolicy({
    allowedRepositoryRoots: config.allowedRepositoryRoots,
    allowUnc: config.allowUnc,
    worktreeRoot: config.worktreeRoot,
    recoveryRoot: config.recoveryRoot,
    gitBinary: config.gitBinary,
    platform: config.platform,
  });
  for (const warning of policy.warnings) {
    log('warn', {
      eventType: 'runner.policy_warning',
      message: warning,
      status: 'degraded',
    });
  }
  if (policy.configError) {
    log('warn', {
      eventType: 'runner.policy_not_configured',
      message: 'Repository path policy is not usable; repository validation will fail closed',
      status: 'degraded',
      error: policy.configError,
    });
  }
  const client = new RunnerClient({
    config,
    onFatal: (message) => {
      log('error', {
        eventType: 'runner.fatal',
        message,
        status: 'error',
      });
      void shutdown(1);
    },
  });

  async function shutdown(exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', {
      eventType: 'runner.stopping',
      message: 'Runner is shutting down',
      status: 'offline',
    });
    try {
      await client.stop();
    } finally {
      healthServer?.close();
      process.exit(exitCode);
    }
  }

  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });

  try {
    await client.start();
  } catch (error) {
    log('error', {
      eventType: 'runner.start_failed',
      message: 'Runner could not start',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  healthServer = startHealthServer(config.healthPort, config.runnerId, client);
  log('info', {
    eventType: 'runner.started',
    message: `Haft runner ${config.runnerId} is connecting to ${config.serverUrl}`,
    status: 'ready',
    mode: config.mode,
    computerId: config.computerId,
    allowedRepositoryRoots: config.allowedRepositoryRoots,
    policyVersion: policy.policyVersion,
    healthPort: config.healthPort,
  });
}

main().catch((error: unknown) => {
  log('error', {
    eventType: 'runner.crashed',
    message: 'Unhandled runner failure',
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
