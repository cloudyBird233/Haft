import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_CODES,
  RUNNER_PROTOCOL_VERSION,
  type ExecutionRepositoryPayload,
  type RunnerEnvelope,
} from '@raft-lite/contracts';
import type { RunnerConfig } from '../src/config';
import {
  RepositoryContextCancelledError,
  RepositoryContextError,
  RepositoryContextManager,
} from '../src/repository-context';
import { RepositoryPathPolicy } from '../src/repository-policy';
import { RunnerClient, type RunnerClientOptions } from '../src/runner-client';

const roots: string[] = [];

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    serverUrl: 'http://127.0.0.1:3001',
    runnerId: 'runner_handshake_test',
    computerId: 'computer_local',
    bootstrapToken: 'bootstrap-token',
    tokenFile: 'runner-handshake-token.json',
    mode: 'fake',
    fakeRuntimes: ['codex'],
    realRuntimes: ['codex'],
    cliPaths: {},
    cliModels: {},
    gitBinary: 'git',
    worktreeRoot: join(tmpdir(), 'haft-handshake-worktrees'),
    keepWorktrees: false,
    recoveryRoot: join(tmpdir(), 'haft-handshake-recovery'),
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
  const root = await mkdtemp(join(tmpdir(), 'haft-handshake-'));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  })
    .toString()
    .trim();
}

function currentBranch(repo: string): string {
  return git(repo, ['symbolic-ref', '--short', 'HEAD']);
}

interface Fixture {
  root: string;
  repo: string;
  canonicalRepo: string;
  branch: string;
  config: RunnerConfig;
  policy: RepositoryPathPolicy;
}

async function makeFixture(): Promise<Fixture> {
  const root = await makeRoot();
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, ['init']);
  await writeFile(join(repo, 'README.md'), '# Fixture\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, [
    '-c',
    'user.name=Haft Test',
    '-c',
    'user.email=haft-test@example.com',
    'commit',
    '-m',
    'initial',
  ]);
  const canonicalRepo = await realpath(repo);
  const config = makeConfig({
    allowedRepositoryRoots: [root],
    worktreeRoot: join(root, 'worktrees'),
    recoveryRoot: join(root, 'recovery'),
  });
  const policy = new RepositoryPathPolicy({
    allowedRepositoryRoots: config.allowedRepositoryRoots,
    allowUnc: config.allowUnc,
    worktreeRoot: config.worktreeRoot,
    recoveryRoot: config.recoveryRoot,
    gitBinary: config.gitBinary,
    platform: config.platform,
  });
  return { root, repo, canonicalRepo, branch: currentBranch(repo), config, policy };
}

function repositoryPayload(
  fixture: Fixture,
  overrides: Partial<ExecutionRepositoryPayload> = {},
): ExecutionRepositoryPayload {
  return {
    executionId: 'execution_handshake',
    projectId: 'project_demo',
    bindingId: 'binding_1',
    bindingVersion: 1,
    path: fixture.repo,
    defaultBranch: fixture.branch,
    policyVersion: fixture.policy.policyVersion,
    ...overrides,
  };
}

function createClient(
  policy: RepositoryPathPolicy,
  config: RunnerConfig,
  options: Partial<RunnerClientOptions> = {},
): { client: RunnerClient; envelopes: RunnerEnvelope[] } {
  const client = new RunnerClient({ config, repositoryPolicy: policy, ...options });
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
  type: string,
  payload: Record<string, unknown>,
): void {
  const envelope: RunnerEnvelope = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    messageId: randomUUID(),
    runnerId: config.runnerId,
    type,
    sentAt: new Date().toISOString(),
    payload,
  };
  (client as unknown as { handleMessage(raw: unknown): void }).handleMessage(envelope);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function privateState(client: RunnerClient): {
  repositoryContexts: RepositoryContextManager;
  executor: {
    start: (payload: unknown, context: unknown) => void;
    canAdmit: (payload: unknown, context: unknown) => unknown;
    cancel: (executionId: string, reason?: string) => void;
  };
} {
  return client as unknown as {
    repositoryContexts: RepositoryContextManager;
    executor: {
      start: (payload: unknown, context: unknown) => void;
      canAdmit: (payload: unknown, context: unknown) => unknown;
      cancel: (executionId: string, reason?: string) => void;
    };
  };
}

function startPayload(executionId: string): Record<string, unknown> {
  return {
    executionId,
    runtime: 'codex',
    taskId: 'task_handshake',
    taskTitle: 'Timing matrix',
    taskDescription: 'Cancel timing',
    projectId: 'project_demo',
    prompt: 'Do it.',
    options: {},
  };
}

async function waitForEnvelope(
  envelopes: RunnerEnvelope[],
  type: string,
  count = 1,
  timeoutMs = 5000,
): Promise<RunnerEnvelope[]> {
  const startedAt = Date.now();
  for (;;) {
    const matches = envelopes.filter((envelope) => envelope.type === type);
    if (matches.length >= count) return matches;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Expected ${count} ${type} message(s), got ${matches.length}; saw ${envelopes
          .map((envelope) => envelope.type)
          .join(', ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
});

describe('RepositoryContextManager', () => {
  it('creates one context per execution id and reuses it for identical params', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);
    const payload = repositoryPayload(fixture);

    const first = await manager.prepare(payload);
    const second = await manager.prepare(payload);

    expect(first.contextId).toBe(second.contextId);
    expect(first.canonicalPath).toBe(fixture.canonicalRepo);
    expect(first.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(second.state).toBe('ready');
  });

  it('conflicts when the same execution id is reused with different params', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);
    await manager.prepare(repositoryPayload(fixture));

    await expect(
      manager.prepare(repositoryPayload(fixture, { bindingVersion: 2 })),
    ).rejects.toMatchObject({ code: ERROR_CODES.REPOSITORY_CONTEXT_CONFLICT });
  });

  it('rejects a policy version that differs from the live policy', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);

    await expect(
      manager.prepare(repositoryPayload(fixture, { policyVersion: 'other-policy' })),
    ).rejects.toMatchObject({ code: ERROR_CODES.REPOSITORY_POLICY_CHANGED });
  });

  it('fails with REPO_DEFAULT_BRANCH_NOT_FOUND when the branch does not exist', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);

    await expect(
      manager.prepare(
        repositoryPayload(fixture, {
          executionId: 'execution_missing_branch',
          defaultBranch: 'missing',
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND });
  });

  it('sweeps ready contexts after the 10 minute pre-start TTL but not started ones', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);
    await manager.prepare(repositoryPayload(fixture, { executionId: 'execution_ttl_ready' }));
    await manager.prepare(repositoryPayload(fixture, { executionId: 'execution_ttl_started' }));
    expect(manager.beginStart('execution_ttl_started')).toBe('acquired');
    manager.markStarted('execution_ttl_started');

    manager.sweep(Date.now() + 10 * 60_000 + 1_000);

    expect(manager.get('execution_ttl_ready')).toBeNull();
    expect(manager.get('execution_ttl_started')).not.toBeNull();
  });

  it('reports a context error with a concrete code instead of throwing a raw Error', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, null);

    await expect(manager.prepare(repositoryPayload(fixture))).rejects.toBeInstanceOf(
      RepositoryContextError,
    );
  });

  it('F3: shares one in-flight prepare and one contextId for concurrent duplicates', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);
    const gate = deferred<void>();
    const originalValidate = fixture.policy.validate.bind(fixture.policy);
    const validate = vi.spyOn(fixture.policy, 'validate').mockImplementation(async (path) => {
      await gate.promise;
      return originalValidate(path);
    });
    const payload = repositoryPayload(fixture);

    const first = manager.prepare(payload);
    const second = manager.prepare(payload);
    // The second caller must join the first operation before any git work.
    expect(validate).toHaveBeenCalledTimes(1);

    gate.resolve();
    const [left, right] = await Promise.all([first, second]);
    expect(left.contextId).toBe(right.contextId);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('F3: rejects a different request while a prepare is in-flight without cancelling the first', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);
    const gate = deferred<void>();
    const originalValidate = fixture.policy.validate.bind(fixture.policy);
    vi.spyOn(fixture.policy, 'validate').mockImplementation(async (path) => {
      await gate.promise;
      return originalValidate(path);
    });

    const first = manager.prepare(repositoryPayload(fixture));
    await expect(
      manager.prepare(repositoryPayload(fixture, { bindingVersion: 2 })),
    ).rejects.toMatchObject({ code: ERROR_CODES.REPOSITORY_CONTEXT_CONFLICT });

    gate.resolve();
    const context = await first;
    expect(context.bindingVersion).toBe(1);
    expect(manager.get(context.executionId)?.contextId).toBe(context.contextId);
  });

  it('F3/F1: cancel aborts an in-flight prepare and leaves no context behind', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);
    const gate = deferred<void>();
    const originalValidate = fixture.policy.validate.bind(fixture.policy);
    vi.spyOn(fixture.policy, 'validate').mockImplementation(async (path) => {
      await gate.promise;
      return originalValidate(path);
    });
    const payload = repositoryPayload(fixture, { executionId: 'execution_cancel_prepare' });

    const preparing = manager.prepare(payload);
    expect(manager.cancel(payload.executionId, 'operator cancel')).toBe(true);
    gate.resolve();

    await expect(preparing).rejects.toBeInstanceOf(RepositoryContextCancelledError);
    expect(manager.get(payload.executionId)).toBeNull();
  });

  it('F5: sweeps a starting context after the short admission TTL', async () => {
    const fixture = await makeFixture();
    const manager = new RepositoryContextManager(fixture.config, fixture.policy);
    const payload = repositoryPayload(fixture, { executionId: 'execution_ttl_starting' });
    await manager.prepare(payload);
    expect(manager.beginStart(payload.executionId)).toBe('acquired');

    manager.sweep(Date.now() + 61_000);

    expect(manager.get(payload.executionId)).toBeNull();
  });
});

describe('RunnerClient execution repository handshake', () => {
  it('orders repository accepted before start accepted and admits before spawning', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const executor = (
      client as unknown as {
        executor: { start: (payload: unknown, context: unknown) => void };
      }
    ).executor;
    const originalStart = executor.start.bind(executor);
    let acceptedBeforeStart = false;
    executor.start = (payload, context) => {
      acceptedBeforeStart = envelopes.some((envelope) => envelope.type === 'execution.accepted');
      originalStart(payload, context);
    };

    deliver(client, fixture.config, 'execution.repository', repositoryPayload(fixture));
    const repositoryAccepted = await waitForEnvelope(envelopes, 'execution.repository.accepted');
    expect(repositoryAccepted[0]?.payload).toMatchObject({
      executionId: 'execution_handshake',
      defaultBranch: fixture.branch,
      canonicalPath: fixture.canonicalRepo,
    });

    deliver(client, fixture.config, 'execution.start', {
      executionId: 'execution_handshake',
      runtime: 'codex',
      taskId: 'task_handshake',
      taskTitle: 'Handshake ordering',
      taskDescription: 'Order assertion',
      projectId: 'project_demo',
      prompt: 'Do it.',
      options: {},
    });
    await waitForEnvelope(envelopes, 'execution.accepted');

    const types = envelopes.map((envelope) => envelope.type);
    expect(types.indexOf('execution.repository.accepted')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('execution.accepted')).toBeGreaterThan(
      types.indexOf('execution.repository.accepted'),
    );
    expect(types).not.toContain('execution.start.rejected');
    expect(acceptedBeforeStart).toBe(true);
  });

  it('rejects execution.start before any repository context exists', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);

    deliver(client, fixture.config, 'execution.start', {
      executionId: 'execution_no_context',
      runtime: 'codex',
      taskId: 'task_handshake',
      taskTitle: 'No context',
      taskDescription: 'Reject before context',
      projectId: 'project_demo',
      prompt: 'Do it.',
      options: {},
    });

    const rejected = await waitForEnvelope(envelopes, 'execution.start.rejected');
    expect(rejected[0]?.payload).toMatchObject({
      executionId: 'execution_no_context',
      code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
    });
    expect(envelopes.map((envelope) => envelope.type)).not.toContain('execution.accepted');
  });

  it('releases the context on execution.cancel and rejects a later start', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);

    deliver(client, fixture.config, 'execution.repository', repositoryPayload(fixture));
    await waitForEnvelope(envelopes, 'execution.repository.accepted');
    deliver(client, fixture.config, 'execution.cancel', {
      executionId: 'execution_handshake',
      reason: 'stop',
    });
    deliver(client, fixture.config, 'execution.start', {
      executionId: 'execution_handshake',
      runtime: 'codex',
      taskId: 'task_handshake',
      taskTitle: 'Cancelled',
      taskDescription: 'Cancel before start',
      projectId: 'project_demo',
      prompt: 'Do it.',
      options: {},
    });

    const rejected = await waitForEnvelope(envelopes, 'execution.start.rejected');
    expect(rejected[0]?.payload).toMatchObject({
      code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
    });
  });

  it('rejects a repository payload whose policy version changed', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);

    deliver(
      client,
      fixture.config,
      'execution.repository',
      repositoryPayload(fixture, { policyVersion: 'stale-policy' }),
    );

    const rejected = await waitForEnvelope(envelopes, 'execution.repository.rejected');
    expect(rejected[0]?.payload).toMatchObject({
      executionId: 'execution_handshake',
      code: ERROR_CODES.REPOSITORY_POLICY_CHANGED,
    });
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      'execution.repository.accepted',
    );
  });

  it('answers a duplicate start idempotently without a second admission failure', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    deliver(client, fixture.config, 'execution.repository', repositoryPayload(fixture));
    await waitForEnvelope(envelopes, 'execution.repository.accepted');

    const startPayload = {
      executionId: 'execution_handshake',
      runtime: 'codex',
      taskId: 'task_handshake',
      taskTitle: 'Duplicate start',
      taskDescription: 'Idempotency',
      projectId: 'project_demo',
      prompt: 'Do it.',
      options: {},
    };
    deliver(client, fixture.config, 'execution.start', startPayload);
    await waitForEnvelope(envelopes, 'execution.accepted');
    deliver(client, fixture.config, 'execution.start', startPayload);
    await waitForEnvelope(envelopes, 'execution.accepted', 2);

    expect(
      envelopes.filter((envelope) => envelope.type === 'execution.start.rejected'),
    ).toHaveLength(0);
  });
});

describe('WP-C F1 cancel timing matrix (A-G)', () => {
  const EXECUTION_ID = 'execution_cancel_matrix';

  it('A: cancel during an in-flight prepare aborts it without inserting a context', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const manager = privateState(client).repositoryContexts;
    const gate = deferred<void>();
    const originalValidate = fixture.policy.validate.bind(fixture.policy);
    const validate = vi.spyOn(fixture.policy, 'validate').mockImplementation(async (path) => {
      await gate.promise;
      return originalValidate(path);
    });
    const payload = repositoryPayload(fixture, { executionId: EXECUTION_ID });

    deliver(client, fixture.config, 'execution.repository', payload);
    expect(validate).toHaveBeenCalledTimes(1);

    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'cancel during prepare',
    });
    const cancelled = await waitForEnvelope(envelopes, 'execution.cancelled');
    expect(cancelled).toHaveLength(1);

    gate.resolve();
    await delay(150);

    expect(manager.get(EXECUTION_ID)).toBeNull();
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      'execution.repository.accepted',
    );
    expect(envelopes.map((envelope) => envelope.type)).not.toContain('execution.accepted');
  });

  it('B: cancel after repository accepted suppresses start acceptance and spawn', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const executor = privateState(client).executor;
    const start = vi.spyOn(executor, 'start');
    const payload = repositoryPayload(fixture, { executionId: EXECUTION_ID });

    deliver(client, fixture.config, 'execution.repository', payload);
    const acceptedRepository = await waitForEnvelope(envelopes, 'execution.repository.accepted');

    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'cancel before start',
    });
    await waitForEnvelope(envelopes, 'execution.cancelled');

    deliver(client, fixture.config, 'execution.start', startPayload(EXECUTION_ID));
    const rejected = await waitForEnvelope(envelopes, 'execution.start.rejected');

    expect(rejected[0]?.payload).toMatchObject({
      executionId: EXECUTION_ID,
      code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
    });
    expect(envelopes.filter((envelope) => envelope.type === 'execution.accepted')).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
    expect(
      envelopes.indexOf(acceptedRepository[0]!) <
        envelopes.indexOf(envelopes.find((envelope) => envelope.type === 'execution.cancelled')!),
    ).toBe(true);
  });

  it('C: cancel during a slow live admission suppresses accepted and spawn', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const executor = privateState(client).executor;
    const start = vi.spyOn(executor, 'start');
    const admissionStarted = deferred<void>();
    const admissionGate = deferred<void>();
    const originalCanAdmit = executor.canAdmit.bind(executor);
    executor.canAdmit = async (payload, context) => {
      admissionStarted.resolve(undefined);
      await admissionGate.promise;
      return originalCanAdmit(payload, context);
    };

    deliver(
      client,
      fixture.config,
      'execution.repository',
      repositoryPayload(fixture, { executionId: EXECUTION_ID }),
    );
    await waitForEnvelope(envelopes, 'execution.repository.accepted');
    deliver(client, fixture.config, 'execution.start', startPayload(EXECUTION_ID));
    await admissionStarted.promise;

    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'cancel during admission',
    });
    await waitForEnvelope(envelopes, 'execution.cancelled');
    admissionGate.resolve(undefined);
    await delay(100);

    expect(envelopes.filter((envelope) => envelope.type === 'execution.accepted')).toHaveLength(0);
    expect(
      envelopes.filter((envelope) => envelope.type === 'execution.start.rejected'),
    ).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('D: cancel with an active session uses process termination and emits one cancelled', async () => {
    const fixture = await makeFixture();
    fixture.config.stepMs = 1000;
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const manager = privateState(client).repositoryContexts;
    const executor = privateState(client).executor;
    const cancel = vi.spyOn(executor, 'cancel');

    deliver(
      client,
      fixture.config,
      'execution.repository',
      repositoryPayload(fixture, { executionId: EXECUTION_ID }),
    );
    await waitForEnvelope(envelopes, 'execution.repository.accepted');
    deliver(client, fixture.config, 'execution.start', startPayload(EXECUTION_ID));
    await waitForEnvelope(envelopes, 'execution.accepted');

    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'cancel active process',
    });
    await waitForEnvelope(envelopes, 'execution.cancelled');
    await delay(50);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(envelopes.filter((envelope) => envelope.type === 'execution.accepted')).toHaveLength(1);
    expect(envelopes.filter((envelope) => envelope.type === 'execution.cancelled')).toHaveLength(1);
    expect(
      envelopes.filter((envelope) => envelope.type === 'execution.start.rejected'),
    ).toHaveLength(0);
    expect(manager.get(EXECUTION_ID)).toBeNull();
  });

  it('E: cancel before any repository context or session is confirmed immediately', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);

    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'cancel before repository',
    });
    await waitForEnvelope(envelopes, 'execution.cancelled');
    // A duplicate cancel must not emit another terminal confirmation.
    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'duplicate cancel',
    });
    await delay(50);

    expect(envelopes.filter((envelope) => envelope.type === 'execution.cancelled')).toHaveLength(1);
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      'execution.repository.accepted',
    );
    expect(envelopes.map((envelope) => envelope.type)).not.toContain('execution.accepted');
  });

  it('F: concurrent duplicate repositories share one prepare and one cancel aborts both', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const manager = privateState(client).repositoryContexts;
    const gate = deferred<void>();
    const originalValidate = fixture.policy.validate.bind(fixture.policy);
    const validate = vi.spyOn(fixture.policy, 'validate').mockImplementation(async (path) => {
      await gate.promise;
      return originalValidate(path);
    });
    const payload = repositoryPayload(fixture, { executionId: EXECUTION_ID });

    deliver(client, fixture.config, 'execution.repository', payload);
    deliver(client, fixture.config, 'execution.repository', payload);
    expect(validate).toHaveBeenCalledTimes(1);

    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'cancel duplicate prepare',
    });
    await waitForEnvelope(envelopes, 'execution.cancelled');
    gate.resolve();
    await delay(150);

    expect(manager.get(EXECUTION_ID)).toBeNull();
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      'execution.repository.accepted',
    );
    expect(
      envelopes.filter((envelope) => envelope.type === 'execution.repository.rejected'),
    ).toHaveLength(0);
  });

  it('G: late repository and start after cancel cannot resurrect a context or spawn', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const manager = privateState(client).repositoryContexts;
    const executor = privateState(client).executor;
    const start = vi.spyOn(executor, 'start');
    const payload = repositoryPayload(fixture, { executionId: EXECUTION_ID });

    deliver(client, fixture.config, 'execution.cancel', {
      executionId: EXECUTION_ID,
      reason: 'cancel first',
    });
    await waitForEnvelope(envelopes, 'execution.cancelled');

    deliver(client, fixture.config, 'execution.repository', payload);
    deliver(client, fixture.config, 'execution.start', startPayload(EXECUTION_ID));
    const rejected = await waitForEnvelope(envelopes, 'execution.start.rejected');
    await delay(50);

    expect(rejected[0]?.payload).toMatchObject({
      executionId: EXECUTION_ID,
      code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
    });
    expect(manager.get(EXECUTION_ID)).toBeNull();
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      'execution.repository.accepted',
    );
    expect(envelopes.map((envelope) => envelope.type)).not.toContain('execution.accepted');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('WP-C F2 live CLI admission', () => {
  function realConfig(fixture: Fixture): RunnerConfig {
    return {
      ...fixture.config,
      mode: 'real',
      fakeRuntimes: [],
      realRuntimes: ['codex'],
      maxConcurrentExecutions: 1,
    };
  }

  it('rejects a missing CLI before accepted and never spawns', async () => {
    const fixture = await makeFixture();
    const probe = vi.fn(async () => ({ authenticated: true, message: null }));
    const spawn = vi.fn(() => {
      throw new Error('spawnProcess must not be called for a missing CLI');
    });
    const { client, envelopes } = createClient(fixture.policy, realConfig(fixture), {
      realExecutorDependencies: {
        resolveExecutable: async () => ({
          path: null,
          searched: [],
          error: 'codex was not found on PATH',
        }),
        probeAuthentication: probe,
        spawnProcess: spawn,
      },
    });

    deliver(client, fixture.config, 'execution.repository', repositoryPayload(fixture));
    await waitForEnvelope(envelopes, 'execution.repository.accepted');
    deliver(client, fixture.config, 'execution.start', startPayload('execution_handshake'));

    const rejected = await waitForEnvelope(envelopes, 'execution.start.rejected');
    expect(rejected[0]?.payload).toMatchObject({
      code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
    });
    expect(String((rejected[0]?.payload as { message?: string }).message)).toMatch(
      /^CLI_NOT_INSTALLED: /,
    );
    expect(envelopes.filter((envelope) => envelope.type === 'execution.accepted')).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated CLI before accepted and never spawns', async () => {
    const fixture = await makeFixture();
    const spawn = vi.fn(() => {
      throw new Error('spawnProcess must not be called for an unauthenticated CLI');
    });
    const { client, envelopes } = createClient(fixture.policy, realConfig(fixture), {
      realExecutorDependencies: {
        resolveExecutable: async () => ({
          path: '/virtual/codex',
          searched: ['/virtual'],
          error: null,
        }),
        probeAuthentication: async () => ({
          authenticated: false,
          message: 'not logged in',
        }),
        spawnProcess: spawn,
      },
    });

    deliver(client, fixture.config, 'execution.repository', repositoryPayload(fixture));
    await waitForEnvelope(envelopes, 'execution.repository.accepted');
    deliver(client, fixture.config, 'execution.start', startPayload('execution_handshake'));

    const rejected = await waitForEnvelope(envelopes, 'execution.start.rejected');
    expect(rejected[0]?.payload).toMatchObject({
      code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
    });
    expect(String((rejected[0]?.payload as { message?: string }).message)).toMatch(
      /^CLI_NOT_AUTHENTICATED: /,
    );
    expect(envelopes.filter((envelope) => envelope.type === 'execution.accepted')).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('releases a starting context when admission throws', async () => {
    const fixture = await makeFixture();
    const { client, envelopes } = createClient(fixture.policy, fixture.config);
    const manager = privateState(client).repositoryContexts;
    const executor = privateState(client).executor;
    executor.canAdmit = async () => {
      throw new Error('admission exploded');
    };

    deliver(client, fixture.config, 'execution.repository', repositoryPayload(fixture));
    await waitForEnvelope(envelopes, 'execution.repository.accepted');
    deliver(client, fixture.config, 'execution.start', startPayload('execution_handshake'));

    const rejected = await waitForEnvelope(envelopes, 'execution.start.rejected');
    expect(rejected[0]?.payload).toMatchObject({
      code: ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
    });
    expect(manager.get('execution_handshake')).toBeNull();
    expect(envelopes.filter((envelope) => envelope.type === 'execution.accepted')).toHaveLength(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
