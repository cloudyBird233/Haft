import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_CODES,
  RUNNER_PROTOCOL_VERSION,
  type RepositoryValidatePayload,
  type RepositoryValidationPayload,
  type RunnerEnvelope,
} from '@raft-lite/contracts';
import type { RunnerConfig } from '../src/config';
import { RepositoryPathPolicy } from '../src/repository-policy';
import { RUNNER_IMPLEMENTED_FEATURES, RunnerClient } from '../src/runner-client';

const roots: string[] = [];

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    serverUrl: 'http://127.0.0.1:3001',
    runnerId: 'runner_validation_test',
    computerId: 'computer_local',
    bootstrapToken: 'bootstrap-token',
    tokenFile: 'runner-validation-token.json',
    mode: 'fake',
    fakeRuntimes: ['codex'],
    realRuntimes: ['codex'],
    cliPaths: {},
    cliModels: {},
    gitBinary: 'git',
    worktreeRoot: join(tmpdir(), 'haft-validation-worktrees'),
    keepWorktrees: false,
    recoveryRoot: join(tmpdir(), 'haft-validation-recovery'),
    shutdownGraceMs: 100,
    cliTimeoutMs: 60_000,
    allowAutoApprove: false,
    allowedRepositoryRoots: [],
    allowUnc: false,
    stepMs: 10,
    healthPort: 0,
    maxConcurrentExecutions: 1,
    runnerVersion: '0.1.0',
    platform: process.platform,
    architecture: process.arch,
    ...overrides,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'haft-validation-'));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  });
}

async function initRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, ['init']);
  await writeFile(join(path, 'README.md'), '# Fixture\n', 'utf8');
  git(path, ['add', 'README.md']);
  git(path, [
    '-c',
    'user.name=Haft Test',
    '-c',
    'user.email=haft-test@example.com',
    'commit',
    '-m',
    'initial',
  ]);
  return realpath(path);
}

function request(overrides: Partial<RepositoryValidatePayload> = {}): RepositoryValidatePayload {
  return {
    requestId: randomUUID(),
    projectId: 'project_demo',
    computerId: 'computer_local',
    bindingId: 'binding_1',
    bindingVersion: 1,
    path: '/repos/demo',
    ...overrides,
  };
}

function stubPolicy(
  validate: (path: string) => Promise<Awaited<ReturnType<RepositoryPathPolicy['validate']>>>,
  overrides: { policyVersion?: string; configError?: RepositoryPathPolicy['configError'] } = {},
): RepositoryPathPolicy {
  return {
    policyVersion: overrides.policyVersion ?? 'policy-test',
    configError: overrides.configError ?? null,
    platform: process.platform,
    warnings: [],
    validate,
    assertStillAllowed: async () => undefined,
  } as unknown as RepositoryPathPolicy;
}

function createClient(
  policy: RepositoryPathPolicy,
  config = makeConfig(),
): {
  client: RunnerClient;
  envelopes: RunnerEnvelope[];
} {
  const client = new RunnerClient({ config, repositoryPolicy: policy });
  const envelopes: RunnerEnvelope[] = [];
  const fakeSocket = {
    connected: true,
    emit: (_event: string, envelope: RunnerEnvelope) => {
      envelopes.push(envelope);
    },
    removeAllListeners: () => undefined,
    disconnect: () => undefined,
  };
  (client as unknown as { socket: unknown }).socket = fakeSocket;
  return { client, envelopes };
}

function deliver(
  client: RunnerClient,
  config: RunnerConfig,
  payload: RepositoryValidatePayload,
): void {
  const envelope: RunnerEnvelope = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    messageId: randomUUID(),
    runnerId: config.runnerId,
    type: 'repository.validate',
    sentAt: new Date().toISOString(),
    payload,
  };
  (client as unknown as { handleMessage(raw: unknown): void }).handleMessage(envelope);
}

async function waitForResponse(
  envelopes: RunnerEnvelope[],
  count = 1,
  timeoutMs = 5000,
): Promise<RepositoryValidationPayload[]> {
  const startedAt = Date.now();
  for (;;) {
    const responses = envelopes
      .filter((envelope) => envelope.type === 'repository.validation')
      .map((envelope) => envelope.payload as RepositoryValidationPayload);
    if (responses.length >= count) return responses;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Expected ${count} repository.validation messages, got ${responses.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
});

describe('RunnerClient repository.validate', () => {
  it('validates a real Git root and returns the policy facts unchanged', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const config = makeConfig({
      allowedRepositoryRoots: [root],
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
    });
    const policy = new RepositoryPathPolicy({
      allowedRepositoryRoots: [root],
      allowUnc: false,
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
      gitBinary: 'git',
      platform: process.platform,
    });
    const { client, envelopes } = createClient(policy, config);
    const payload = request({ path: repo });

    deliver(client, config, payload);
    const response = (await waitForResponse(envelopes))[0]!;

    expect(response).toMatchObject({
      requestId: payload.requestId,
      projectId: payload.projectId,
      computerId: payload.computerId,
      bindingId: payload.bindingId,
      bindingVersion: payload.bindingVersion,
      ok: true,
      platform: process.platform,
      policyVersion: policy.policyVersion,
      canonicalPath: repo,
    });
    expect(response.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns the policy path failure code and message', async () => {
    const policy = stubPolicy(async () => ({
      ok: false,
      platform: process.platform,
      policyVersion: 'policy-test',
      errorCode: ERROR_CODES.REPO_PATH_NOT_FOUND,
      message: 'Repository path does not exist on the runner host',
    }));
    const config = makeConfig();
    const { client, envelopes } = createClient(policy, config);
    const payload = request({ path: '/missing' });

    deliver(client, config, payload);
    const response = (await waitForResponse(envelopes))[0]!;

    expect(response.ok).toBe(false);
    expect(response.errorCode).toBe(ERROR_CODES.REPO_PATH_NOT_FOUND);
    expect(response.message).toContain('does not exist');
  });

  it('rejects a request for another computer without invoking the policy', async () => {
    const validate = vi.fn();
    const policy = stubPolicy(validate);
    const config = makeConfig();
    const { client, envelopes } = createClient(policy, config);
    const payload = request({ computerId: 'computer_other' });

    deliver(client, config, payload);
    const response = (await waitForResponse(envelopes))[0]!;

    expect(validate).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expect(response.errorCode).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
    expect(response.message).toContain('different computer');
  });

  it('maps an unconfigured policy to REPOSITORY_POLICY_NOT_CONFIGURED', async () => {
    const root = await makeRoot();
    const repo = await initRepo(join(root, 'repo'));
    const policy = new RepositoryPathPolicy({
      allowedRepositoryRoots: [],
      allowUnc: false,
      worktreeRoot: join(root, 'worktrees'),
      recoveryRoot: join(root, 'recovery'),
      gitBinary: 'git',
      platform: process.platform,
    });
    const config = makeConfig();
    const { client, envelopes } = createClient(policy, config);
    const payload = request({ path: repo });

    deliver(client, config, payload);
    const response = (await waitForResponse(envelopes))[0]!;

    expect(response.ok).toBe(false);
    expect(response.errorCode).toBe(ERROR_CODES.REPOSITORY_POLICY_NOT_CONFIGURED);
  });

  it('converts an unexpected policy exception to REPO_VALIDATION_FAILED', async () => {
    const policy = stubPolicy(async () => {
      throw new Error('boom');
    });
    const config = makeConfig();
    const { client, envelopes } = createClient(policy, config);
    const payload = request();

    deliver(client, config, payload);
    const response = (await waitForResponse(envelopes))[0]!;

    expect(response.ok).toBe(false);
    expect(response.errorCode).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
    expect(response.message).toContain('boom');
  });

  it('replays a cached result with a new envelope ID and no second policy run', async () => {
    const validate = vi.fn(async () => ({
      ok: true as const,
      platform: process.platform,
      policyVersion: 'policy-test',
      canonicalPath: '/repos/demo',
      headCommit: 'b'.repeat(40),
    }));
    const policy = stubPolicy(validate);
    const config = makeConfig();
    const { client, envelopes } = createClient(policy, config);
    const payload = request();

    deliver(client, config, payload);
    const first = await waitForResponse(envelopes, 1);
    const firstEnvelope = envelopes.find((envelope) => envelope.type === 'repository.validation');

    deliver(client, config, payload);
    const both = await waitForResponse(envelopes, 2);
    const responseEnvelopes = envelopes.filter(
      (envelope) => envelope.type === 'repository.validation',
    );
    const secondEnvelope = responseEnvelopes[1];

    expect(validate).toHaveBeenCalledTimes(1);
    expect(firstEnvelope?.messageId).toBeTruthy();
    expect(secondEnvelope?.messageId).toBeTruthy();
    expect(secondEnvelope?.messageId).not.toBe(firstEnvelope?.messageId);
    expect(both[1]).toEqual(first[0]);
  });

  it('rejects a reused requestId with a different payload', async () => {
    const validate = vi.fn(async () => ({
      ok: true as const,
      platform: process.platform,
      policyVersion: 'policy-test',
      canonicalPath: '/repos/demo',
      headCommit: 'c'.repeat(40),
    }));
    const policy = stubPolicy(validate);
    const config = makeConfig();
    const { client, envelopes } = createClient(policy, config);
    const first = request();
    const changed = { ...first, path: '/repos/other' };

    deliver(client, config, first);
    await waitForResponse(envelopes, 1);
    deliver(client, config, changed);
    const responses = await waitForResponse(envelopes, 2);

    expect(validate).toHaveBeenCalledTimes(1);
    expect(responses[1]?.ok).toBe(false);
    expect(responses[1]?.errorCode).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
    expect(responses[1]?.message).toContain('different validation payload');
  });
});

describe('RunnerClient capabilities', () => {
  it('advertises all four repository features with an empty projectIds', () => {
    const { client } = createClient(
      stubPolicy(async () => ({ ok: false, platform: process.platform, policyVersion: 'p' })),
    );
    const capabilities = client.advertisedCapabilities();

    expect(capabilities.projectIds).toEqual([]);
    expect(capabilities.features).toEqual([...RUNNER_IMPLEMENTED_FEATURES]);
    expect(capabilities.features).toEqual([
      'project-binding-v1',
      'repository-validation-v1',
      'repository-path-policy-v1',
      'repository-handshake-v1',
    ]);
    expect(makeConfig()).not.toHaveProperty('projectPaths');
  });
});
