import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import type { INestApplication } from '@nestjs/common';
import {
  EXECUTION_DIFF_MAX_BYTES,
  RUNNER_PROTOCOL_VERSION,
  runnerServerMessageSchema,
  type ExecutionDiffDto,
  type ExecutionDto,
  type ExecutionLogDto,
  type ListDto,
  type ProjectBindingDto,
  type ProjectDetailDto,
  type RuntimeAvailabilityDto,
  type RunnerServerMessage,
  type TaskDetailDto,
} from '@raft-lite/contracts';
import { createTestApp, waitFor, type ApiSuccessBody } from './test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RuntimeRegistryService } from '../src/modules/runtime/runtime-registry.service';
import { SEED_IDS } from '../src/common/seed/demo-data';

const BOOTSTRAP = 'test-runner-bootstrap-token';
const RUNNER_ID = 'runner_integration';
const COMPUTER_ID: string = SEED_IDS.computer;

interface ConnectedRunner {
  socket: Socket;
  welcome: Extract<RunnerServerMessage, { type: 'runner.welcome' }>;
}

describe('Runner protocol v1 integration', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let baseUrl: string;
  let prisma: PrismaService;
  let activeSockets: Socket[] = [];

  beforeAll(async () => {
    process.env.HAFT_RUNNER_BOOTSTRAP_TOKEN = BOOTSTRAP;
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    server = app.getHttpServer() as Parameters<typeof request>[0];
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    for (const socket of activeSockets) socket.disconnect();
    activeSockets = [];
    await delay(100);
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    for (const socket of activeSockets) socket.disconnect();
    activeSockets = [];
    await delay(50);
    const response = await request(server).post('/__test__/reset').send({});
    expect(response.status).toBe(200);
  });

  async function connectRunner(
    options: {
      runnerId?: string;
      computerId?: string;
      bootstrapToken?: string;
      token?: string;
    } = {},
  ): Promise<ConnectedRunner> {
    const runnerId = options.runnerId ?? RUNNER_ID;
    const socket = io(`${baseUrl}/runner`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 5000,
      auth: {
        runnerId,
        computerId: options.computerId ?? COMPUTER_ID,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        ...(options.token
          ? { token: options.token }
          : { bootstrapToken: options.bootstrapToken ?? BOOTSTRAP }),
      },
    });
    activeSockets.push(socket);
    const welcome = await waitForMessage(socket, 'runner.welcome', 5000);
    return { socket, welcome };
  }

  function send(
    socket: Socket,
    type: string,
    payload: Record<string, unknown>,
    runnerId = RUNNER_ID,
  ): void {
    socket.emit('runner.message', {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      messageId: randomUUID(),
      runnerId,
      type,
      sentAt: new Date().toISOString(),
      payload,
    });
  }

  async function registerRunner(
    connected: ConnectedRunner,
    runnerId = RUNNER_ID,
    computerId = COMPUTER_ID,
    options: {
      installed?: boolean;
      authenticated?: boolean;
      projectIds?: string[];
      features?: string[];
    } = {},
  ): Promise<void> {
    send(
      connected.socket,
      'runner.register',
      {
        computerId,
        runnerVersion: 'test-runner/1.0.0',
        platform: 'win32',
        architecture: 'x64',
        capabilities: {
          runtimes: [
            {
              runtime: 'codex',
              installed: options.installed ?? true,
              version: '0.164.0-test',
              authenticated: options.authenticated ?? true,
              message: null,
            },
            {
              runtime: 'opencode',
              installed: options.installed ?? true,
              version: '2.2.5-test',
              authenticated: options.authenticated ?? true,
              message: null,
            },
          ],
          projectIds: options.projectIds ?? [SEED_IDS.project],
          maxConcurrentExecutions: 1,
          // P2-01 does not consume runner features. P2-02 will advertise and
          // enforce repository validation/path-policy capabilities.
          features: options.features ?? [],
        },
      },
      runnerId,
    );
    send(connected.socket, 'runner.snapshot', { executions: [], pendingLogCount: 0 }, runnerId);
    await waitFor(async () => {
      const row = await prisma.runner.findUnique({ where: { id: runnerId } });
      return row?.status === 'online' && row.runnerVersion === 'test-runner/1.0.0';
    }, 4000);
  }

  async function createBinding(projectId = SEED_IDS.project): Promise<ProjectBindingDto> {
    const path = `/test/repos/${randomUUID()}`;
    const created = await request(server)
      .post(`/api/projects/${projectId}/bindings`)
      .send({ computerId: COMPUTER_ID, path })
      .expect(201);
    return (created.body as ApiSuccessBody<ProjectBindingDto>).data;
  }

  /**
   * P2-01 never writes `ready` through its API and never talks to the Runner
   * for bindings. Success paths therefore use the test-only fixture, which is
   * available only with E2E_TEST_MODE=true.
   */
  async function ensureReadyBinding(projectId = SEED_IDS.project): Promise<ProjectBindingDto> {
    const detail = await request(server).get(`/api/projects/${projectId}`).expect(200);
    const existing = (detail.body as ApiSuccessBody<ProjectDetailDto>).data.bindings.find(
      (binding) => binding.computerId === COMPUTER_ID,
    );
    const binding = existing ?? (await createBinding(projectId));
    const ready = await request(server)
      .post(`/__test__/projects/${projectId}/bindings/${binding.id}/ready`)
      .send({})
      .expect(200);
    return (ready.body as ApiSuccessBody<ProjectBindingDto>).data;
  }

  async function createCodexTask(): Promise<{ agentId: string; taskId: string }> {
    const createdAgent = await request(server)
      .post('/api/agents')
      .send({
        name: `Runner Agent ${randomUUID().slice(0, 8)}`,
        role: 'Runner Integration',
        description: 'Exercises the runner protocol.',
        runtime: 'codex',
        computerId: COMPUTER_ID,
      })
      .expect(201);
    const agent = (createdAgent.body as ApiSuccessBody<{ id: string }>).data;
    const createdTask = await request(server)
      .post('/api/tasks')
      .send({
        title: `Runner task ${randomUUID().slice(0, 8)}`,
        description: 'Complete the runner integration loop.',
        projectId: SEED_IDS.project,
        assigneeAgentId: agent.id,
      })
      .expect(201);
    const task = (createdTask.body as ApiSuccessBody<{ id: string }>).data;
    return { agentId: agent.id, taskId: task.id };
  }

  async function startAndAccept(connected: ConnectedRunner): Promise<{
    executionId: string;
    taskId: string;
    agentId: string;
    binding: ProjectBindingDto;
    start: Extract<RunnerServerMessage, { type: 'execution.start' }>;
  }> {
    const binding = await ensureReadyBinding();
    const { agentId, taskId } = await createCodexTask();
    const startMessage = waitForMessage(connected.socket, 'execution.start', 5000);
    const startResponse = Promise.resolve(
      request(server).post(`/api/tasks/${taskId}/start`).send({}),
    );
    const start = await startMessage;
    send(connected.socket, 'execution.accepted', {
      executionId: start.payload.executionId,
      acceptedAt: new Date().toISOString(),
    });
    const response = await startResponse;
    expect(response.status).toBe(201);
    expect((response.body as ApiSuccessBody<ExecutionDto>).data.agentId).toBe(agentId);
    return { executionId: start.payload.executionId, taskId, agentId, binding, start };
  }

  it('pairs, registers, and exposes runtime availability for mapped projects', async () => {
    const connected = await connectRunner();
    expect(connected.welcome.payload.issuedToken).toBeTruthy();
    await registerRunner(connected);

    const availability = await waitFor(async () => {
      const response = await request(server)
        .get(`/api/runtimes?computerId=${COMPUTER_ID}&projectId=${SEED_IDS.project}`)
        .expect(200);
      const items = (response.body as ApiSuccessBody<{ items: RuntimeAvailabilityDto[] }>).data
        .items;
      return items.find((item) => item.runtime === 'codex' && item.available);
    });
    expect(availability.runnerId).toBe(RUNNER_ID);
    expect(availability.cliVersion).toBe('0.164.0-test');

    const runners = await request(server).get('/api/runners').expect(200);
    const runner = (runners.body as ApiSuccessBody<ListDto<{ id: string; status: string }>>).data
      .items[0];
    expect(runner).toMatchObject({ id: RUNNER_ID, status: 'online' });

    const unmapped = await request(server)
      .get(`/api/runtimes?computerId=${COMPUTER_ID}&projectId=project_other`)
      .expect(200);
    const codex = (
      unmapped.body as ApiSuccessBody<{ items: RuntimeAvailabilityDto[] }>
    ).data.items.find((item) => item.runtime === 'codex');
    expect(codex).toMatchObject({ available: false, reasonCode: 'PROJECT_NOT_MAPPED' });
  });

  it('blocks real executions until the binding is ready for its current version', async () => {
    const { taskId } = await createCodexTask();

    const missing = await request(server).post(`/api/tasks/${taskId}/start`).send({}).expect(409);
    expect(missing.body.error.code).toBe('PROJECT_BINDING_MISSING');

    const binding = await createBinding();
    const unverified = await request(server)
      .post(`/api/tasks/${taskId}/start`)
      .send({})
      .expect(409);
    expect(unverified.body.error.code).toBe('PROJECT_BINDING_NOT_READY');
    expect(unverified.body.error.details).toMatchObject({
      bindingId: binding.id,
      bindingStatus: 'unverified',
      bindingVersion: binding.bindingVersion,
      validatedBindingVersion: null,
    });

    await prisma.projectRepositoryBinding.update({
      where: { id: binding.id },
      data: {
        status: 'ready',
        validatedBindingVersion: binding.bindingVersion - 1,
      },
    });
    const stale = await request(server).post(`/api/tasks/${taskId}/start`).send({}).expect(409);
    expect(stale.body.error.code).toBe('PROJECT_BINDING_NOT_READY');
    expect(stale.body.error.details).toMatchObject({
      bindingStatus: 'ready',
      bindingVersion: binding.bindingVersion,
      validatedBindingVersion: binding.bindingVersion - 1,
    });
  });

  it('never sends runner messages for P2-01 binding CRUD', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    await delay(100);

    const received: string[] = [];
    const handler = (raw: unknown): void => {
      const parsed = runnerServerMessageSchema.safeParse(raw);
      if (parsed.success) received.push(parsed.data.type);
    };
    connected.socket.on('runner.message', handler);
    try {
      const binding = await createBinding();
      const changed = await request(server)
        .patch(`/api/projects/${SEED_IDS.project}/bindings/${binding.id}`)
        .send({ path: `${binding.path}-moved` })
        .expect(200);
      expect((changed.body as ApiSuccessBody<ProjectBindingDto>).data.status).toBe('unverified');
      await request(server)
        .delete(`/api/projects/${SEED_IDS.project}/bindings/${binding.id}`)
        .expect(200);
      await delay(200);
    } finally {
      connected.socket.off('runner.message', handler);
    }

    expect(received).toEqual([]);
  });

  it('rejects an archived project even when its binding is ready and a runner is online', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    await ensureReadyBinding();
    const { agentId, taskId } = await createCodexTask();
    const beforeTask = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    const beforeAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    await request(server)
      .patch(`/api/projects/${SEED_IDS.project}`)
      .send({ archived: true })
      .expect(200);
    const blocked = await request(server).post(`/api/tasks/${taskId}/start`).send({}).expect(409);
    expect(blocked.body.error.code).toBe('PROJECT_ARCHIVED');

    expect(await prisma.execution.count({ where: { taskId } })).toBe(0);
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(taskAfter.status).toBe(beforeTask.status);
    expect(taskAfter.assigneeAgentId).toBe(beforeTask.assigneeAgentId);
    const agentAfter = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agentAfter.status).toBe(beforeAgent.status);
    expect(agentAfter.lastActiveAt).toEqual(beforeAgent.lastActiveAt);
  });

  it('rejects a binding that changes between precheck and execution creation', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await ensureReadyBinding();
    const { agentId, taskId } = await createCodexTask();
    const beforeTask = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    const beforeAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const started: string[] = [];
    const handler = (raw: unknown): void => {
      const parsed = runnerServerMessageSchema.safeParse(raw);
      if (parsed.success && parsed.data.type === 'execution.start') {
        started.push(parsed.data.payload.executionId);
      }
    };
    connected.socket.on('runner.message', handler);

    const runtimes = app.get(RuntimeRegistryService);
    const original = runtimes.getAvailability.bind(runtimes);
    let changed = false;
    vi.spyOn(runtimes, 'getAvailability').mockImplementation(
      async (runtime, computerId, projectId) => {
        const availability = await original(runtime, computerId, projectId);
        if (!changed) {
          changed = true;
          await prisma.projectRepositoryBinding.update({
            where: { id: binding.id },
            data: {
              path: `${binding.path}-changed-during-start`,
              pathHash: 'f'.repeat(64),
              bindingVersion: { increment: 1 },
              status: 'unverified',
              validatedBindingVersion: null,
            },
          });
        }
        return availability;
      },
    );

    try {
      const response = await request(server)
        .post(`/api/tasks/${taskId}/start`)
        .send({})
        .expect(409);
      expect(response.body.error.code).toBe('PROJECT_BINDING_NOT_READY');
      expect(response.body.error.details).toMatchObject({
        bindingId: binding.id,
        bindingStatus: 'unverified',
        bindingVersion: binding.bindingVersion + 1,
        validatedBindingVersion: null,
      });
    } finally {
      connected.socket.off('runner.message', handler);
    }
    await delay(200);

    expect(started).toEqual([]);
    expect(await prisma.execution.count({ where: { taskId } })).toBe(0);
    const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(taskAfter.status).toBe(beforeTask.status);
    expect(taskAfter.assigneeAgentId).toBe(beforeTask.assigneeAgentId);
    const agentAfter = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agentAfter.status).toBe(beforeAgent.status);
    expect(agentAfter.lastActiveAt).toEqual(beforeAgent.lastActiveAt);
  });

  it('snapshots the project default branch read inside the execution transaction', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await ensureReadyBinding();
    const { agentId, taskId } = await createCodexTask();

    const started: string[] = [];
    const handler = (raw: unknown): void => {
      const parsed = runnerServerMessageSchema.safeParse(raw);
      if (parsed.success && parsed.data.type === 'execution.start') {
        started.push(parsed.data.payload.executionId);
      }
    };
    connected.socket.on('runner.message', handler);

    const runtimes = app.get(RuntimeRegistryService);
    const original = runtimes.getAvailability.bind(runtimes);
    let branchChanged = false;
    vi.spyOn(runtimes, 'getAvailability').mockImplementation(
      async (runtime, computerId, projectId) => {
        const availability = await original(runtime, computerId, projectId);
        if (!branchChanged) {
          branchChanged = true;
          // The precheck has already loaded the Task relation. Changing the
          // branch here proves the snapshot comes from the transaction re-read,
          // not from the stale `task.project.defaultBranch` value.
          await prisma.project.update({
            where: { id: SEED_IDS.project },
            data: { defaultBranch: 'release/during-start' },
          });
        }
        return availability;
      },
    );

    let executionId = '';
    try {
      const startMessage = waitForMessage(connected.socket, 'execution.start', 5000);
      const startResponse = Promise.resolve(
        request(server).post(`/api/tasks/${taskId}/start`).send({}),
      );
      const start = await startMessage;
      send(connected.socket, 'execution.accepted', {
        executionId: start.payload.executionId,
        acceptedAt: new Date().toISOString(),
      });
      const response = await startResponse;
      expect(response.status).toBe(201);
      const execution = (response.body as ApiSuccessBody<ExecutionDto>).data;
      executionId = execution.id;

      expect(execution).toMatchObject({
        agentId,
        repositoryProjectId: SEED_IDS.project,
        repositoryBindingId: binding.id,
        repositoryBindingVersion: binding.bindingVersion,
        repositoryDefaultBranch: 'release/during-start',
      });
      const stored = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
      expect(stored).toMatchObject({
        repositoryProjectId: SEED_IDS.project,
        repositoryBindingId: binding.id,
        repositoryBindingVersion: binding.bindingVersion,
        repositoryDefaultBranch: 'release/during-start',
      });
    } finally {
      connected.socket.off('runner.message', handler);
    }
    await delay(200);

    expect(branchChanged).toBe(true);
    // Exactly one dispatch: the branch change must not trigger a retry, a
    // second Execution, or a second execution.start message.
    expect(started).toEqual([executionId]);
    expect(await prisma.execution.count({ where: { taskId } })).toBe(1);
  });

  it('runs a complete execution over the runner protocol and persists logs once', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const { executionId, taskId, agentId, binding } = await startAndAccept(connected);

    const running = await request(server).get(`/api/executions/${executionId}`).expect(200);
    const runningExecution = (running.body as ApiSuccessBody<ExecutionDto>).data;
    expect(runningExecution.phase).toBe('queued');
    expect(runningExecution).toMatchObject({
      repositoryProjectId: SEED_IDS.project,
      repositoryBindingId: binding.id,
      repositoryBindingVersion: binding.bindingVersion,
      repositoryDefaultBranch: 'main',
    });

    send(connected.socket, 'execution.phase', {
      executionId,
      phase: 'running',
      message: 'Runner is executing',
    });
    const logs = [
      {
        sequence: 1,
        eventId: randomUUID(),
        stream: 'system',
        level: 'info',
        message: 'Runner attached to the isolated worktree.',
        timestamp: new Date().toISOString(),
      },
      {
        sequence: 2,
        eventId: randomUUID(),
        stream: 'stdout',
        level: 'success',
        message: 'Runner finished the simulated task.',
        timestamp: new Date().toISOString(),
      },
    ];
    send(connected.socket, 'execution.log', { executionId, entries: logs });
    // Same event delivered twice with a fresh envelope must stay idempotent.
    send(connected.socket, 'execution.log', { executionId, entries: logs });
    send(connected.socket, 'execution.progress', {
      executionId,
      progress: 70,
      step: 4,
      progressMode: 'determinate',
    });

    await waitFor(async () => {
      const response = await request(server).get(`/api/executions/${executionId}/logs`).expect(200);
      return (response.body as ApiSuccessBody<ListDto<ExecutionLogDto>>).data.total >= 2;
    });

    send(connected.socket, 'execution.completed', {
      executionId,
      exitCode: 0,
      summary: 'Runner integration completed.',
      git: {
        branchName: `haft/${executionId}`,
        baseCommit: '0'.repeat(40),
        headCommit: 'f'.repeat(40),
        changedFiles: 2,
        diffStat: '2 files changed',
        gitStatus: 'clean',
        diff: [
          'diff --git a/src/example.ts b/src/example.ts',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -1 +1 @@',
          '-export const value = 1;',
          '+export const value = 2;',
        ].join('\n'),
        diffTruncated: false,
      },
    });

    const completed = await waitFor(async () => {
      const response = await request(server).get(`/api/executions/${executionId}`).expect(200);
      const execution = (response.body as ApiSuccessBody<ExecutionDto>).data;
      return execution.status === 'completed' ? execution : null;
    });
    expect(completed).toMatchObject({
      status: 'completed',
      phase: 'completed',
      progress: 100,
      exitCode: 0,
      summary: 'Runner integration completed.',
      runnerId: RUNNER_ID,
      lastRunnerSeq: 2,
    });
    expect(completed.branchName).toBe(`haft/${executionId}`);
    expect(completed.changedFiles).toBe(2);
    expect(completed.gitStatus).toBe('clean');
    expect(completed.diffTruncated).toBe(false);
    // The potentially large patch must never be embedded in the execution DTO.
    expect(completed).not.toHaveProperty('diff');

    const diffResponse = await request(server)
      .get(`/api/executions/${executionId}/diff`)
      .expect(200);
    const storedDiff = (diffResponse.body as ApiSuccessBody<ExecutionDiffDto>).data;
    expect(storedDiff).toMatchObject({
      executionId,
      available: true,
      branchName: `haft/${executionId}`,
      baseCommit: '0'.repeat(40),
      headCommit: 'f'.repeat(40),
      changedFiles: 2,
      diffStat: '2 files changed',
      gitStatus: 'clean',
      diffTruncated: false,
    });
    expect(storedDiff.diff).toContain('-export const value = 1;');
    expect(storedDiff.diff).toContain('+export const value = 2;');
    expect(storedDiff.createdAt).toBeTruthy();

    // A duplicate terminal message must not create a second artifact or change
    // the stored patch.
    send(connected.socket, 'execution.completed', {
      executionId,
      exitCode: 0,
      summary: 'Duplicate completion must be ignored.',
      git: null,
    });
    await delay(200);
    const duplicateDiff = await request(server)
      .get(`/api/executions/${executionId}/diff`)
      .expect(200);
    expect((duplicateDiff.body as ApiSuccessBody<ExecutionDiffDto>).data.diff).toContain(
      '+export const value = 2;',
    );
    const artifactCount = await prisma.executionArtifact.count({ where: { executionId } });
    expect(artifactCount).toBe(1);

    const logResponse = await request(server)
      .get(`/api/executions/${executionId}/logs`)
      .expect(200);
    const storedLogs = (logResponse.body as ApiSuccessBody<ListDto<ExecutionLogDto>>).data;
    // One server-generated phase log plus two runner logs. Runner sequence
    // numbers must not overwrite or collide with server-owned sequence numbers.
    expect(storedLogs.total).toBe(3);
    expect(storedLogs.items.map((log) => log.seq)).toEqual([1, 2, 3]);
    expect(storedLogs.items[0]).toMatchObject({
      message: 'Runner is executing',
      runnerSeq: null,
    });
    expect(storedLogs.items[1]).toMatchObject({ runnerSeq: 1, level: 'info' });
    expect(storedLogs.items[2]).toMatchObject({
      runnerSeq: 2,
      stream: 'stdout',
      level: 'success',
    });

    const taskResponse = await request(server).get(`/api/tasks/${taskId}`).expect(200);
    expect((taskResponse.body as ApiSuccessBody<TaskDetailDto>).data.status).toBe('done');
    const agentResponse = await request(server).get(`/api/agents/${agentId}`).expect(200);
    expect((agentResponse.body as ApiSuccessBody<{ status: string }>).data.status).toBe('idle');
  });

  it('caps an over-limit diff at the byte limit and marks it truncated', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const { executionId } = await startAndAccept(connected);

    // 600k two-byte characters pass the protocol's character-count schema but
    // exceed the byte cap once encoded as UTF-8.
    const oversized = [
      'diff --git a/huge.txt b/huge.txt',
      '--- a/huge.txt',
      '+++ b/huge.txt',
      '@@ -1 +1 @@',
      '-before',
      `+${'é'.repeat(600_000)}`,
    ].join('\n');
    expect(oversized.length).toBeLessThanOrEqual(EXECUTION_DIFF_MAX_BYTES);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(EXECUTION_DIFF_MAX_BYTES);

    send(connected.socket, 'execution.completed', {
      executionId,
      exitCode: 0,
      summary: 'Oversized diff submitted.',
      git: {
        branchName: `haft/${executionId}`,
        baseCommit: '0'.repeat(40),
        headCommit: 'f'.repeat(40),
        changedFiles: 1,
        diffStat: '1 file changed',
        gitStatus: '?? huge.txt',
        diff: oversized,
        // The server must enforce the byte cap even when the runner does not
        // set the flag.
        diffTruncated: false,
      },
    });

    const completed = await waitFor(async () => {
      const response = await request(server).get(`/api/executions/${executionId}`).expect(200);
      const execution = (response.body as ApiSuccessBody<ExecutionDto>).data;
      return execution.status === 'completed' ? execution : null;
    });
    expect(completed.diffTruncated).toBe(true);

    const diffResponse = await request(server)
      .get(`/api/executions/${executionId}/diff`)
      .expect(200);
    const storedDiff = (diffResponse.body as ApiSuccessBody<ExecutionDiffDto>).data;
    expect(storedDiff.diffTruncated).toBe(true);
    expect(Buffer.byteLength(storedDiff.diff, 'utf8')).toBeLessThanOrEqual(
      EXECUTION_DIFF_MAX_BYTES,
    );
    const artifact = await prisma.executionArtifact.findUnique({
      where: { executionId_kind: { executionId, kind: 'git-diff' } },
    });
    expect(artifact?.truncated).toBe(true);
    expect(artifact?.byteSize).toBeLessThanOrEqual(EXECUTION_DIFF_MAX_BYTES);
  });

  it('does not mark an execution cancelled until the runner confirms', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const { executionId } = await startAndAccept(connected);

    const cancelMessage = waitForMessage(connected.socket, 'execution.cancel', 5000);
    const cancelResponse = Promise.resolve(
      request(server)
        .post(`/api/executions/${executionId}/cancel`)
        .send({ reason: 'Stop from integration test' }),
    );
    const cancel = await cancelMessage;
    expect(cancel.payload).toMatchObject({
      executionId,
      reason: 'Stop from integration test',
    });

    await delay(200);
    const during = await request(server).get(`/api/executions/${executionId}`).expect(200);
    expect((during.body as ApiSuccessBody<ExecutionDto>).data.status).toBe('running');

    send(connected.socket, 'execution.cancelled', {
      executionId,
      reason: 'Stop from integration test',
      exitCode: null,
      git: null,
    });
    const cancelled = await cancelResponse;
    expect(cancelled.status).toBe(200);
    const execution = (cancelled.body as ApiSuccessBody<ExecutionDto>).data;
    expect(execution).toMatchObject({
      status: 'cancelled',
      phase: 'cancelled',
      cancelReason: 'Stop from integration test',
    });

    const taskResponse = await request(server).get(`/api/tasks/${execution.taskId}`).expect(200);
    const task = (taskResponse.body as ApiSuccessBody<TaskDetailDto>).data;
    expect(task.status).toBe('cancelled');
  });

  it('fails an execution without re-running when a restarted runner reports no snapshot', async () => {
    const first = await connectRunner();
    await registerRunner(first);
    const { executionId } = await startAndAccept(first);

    first.socket.disconnect();
    await waitFor(async () => {
      const runner = await prisma.runner.findUnique({ where: { id: RUNNER_ID } });
      return runner?.status === 'offline';
    });

    const second = await connectRunner();
    await registerRunner(second);

    const execution = await waitFor(async () => {
      const response = await request(server).get(`/api/executions/${executionId}`).expect(200);
      const value = (response.body as ApiSuccessBody<ExecutionDto>).data;
      return value.status === 'failed' ? value : null;
    });
    expect(execution.failureReason).toBe('RUNNER_RESTARTED');
    expect(execution.phase).toBe('failed');
  });

  it('ignores execution events sent by a runner that does not own the execution', async () => {
    const owner = await connectRunner();
    await registerRunner(owner);
    const { executionId } = await startAndAccept(owner);

    await prisma.computer.upsert({
      where: { id: 'computer_other' },
      update: {},
      create: {
        id: 'computer_other',
        name: 'Other Workstation',
        hostname: 'other',
        status: 'online',
      },
    });
    const intruder = await connectRunner({
      runnerId: 'runner_intruder',
      computerId: 'computer_other',
    });
    await registerRunner(intruder, 'runner_intruder', 'computer_other');

    send(
      intruder.socket,
      'execution.log',
      {
        executionId,
        entries: [
          {
            sequence: 1,
            eventId: randomUUID(),
            stream: 'stdout',
            level: 'info',
            message: 'This log must never be persisted.',
            timestamp: new Date().toISOString(),
          },
        ],
      },
      'runner_intruder',
    );
    send(
      intruder.socket,
      'execution.completed',
      {
        executionId,
        exitCode: 0,
        summary: 'Intruder completion must be ignored.',
        git: {
          branchName: 'haft/intruder',
          baseCommit: '0'.repeat(40),
          headCommit: 'f'.repeat(40),
          changedFiles: 1,
          diffStat: '1 file changed',
          gitStatus: ' M intruder.ts',
          diff: '+intruder diff must never be stored',
          diffTruncated: false,
        },
      },
      'runner_intruder',
    );

    await delay(300);
    const current = await request(server).get(`/api/executions/${executionId}`).expect(200);
    expect((current.body as ApiSuccessBody<ExecutionDto>).data.status).toBe('running');
    const diff = await request(server).get(`/api/executions/${executionId}/diff`).expect(200);
    expect((diff.body as ApiSuccessBody<ExecutionDiffDto>).data).toMatchObject({
      available: false,
      diff: '',
    });
    const logs = await request(server).get(`/api/executions/${executionId}/logs`).expect(200);
    expect((logs.body as ApiSuccessBody<ListDto<ExecutionLogDto>>).data.total).toBe(0);
  });
});

function waitForMessage<T extends RunnerServerMessage['type']>(
  socket: Socket,
  type: T,
  timeoutMs = 5000,
): Promise<Extract<RunnerServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('runner.message', handler);
      reject(new Error(`Timed out waiting for runner message ${type}`));
    }, timeoutMs);
    const handler = (raw: unknown): void => {
      const parsed = runnerServerMessageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type !== type) {
        return;
      }
      clearTimeout(timer);
      socket.off('runner.message', handler);
      resolve(parsed.data as Extract<RunnerServerMessage, { type: T }>);
    };
    socket.on('runner.message', handler);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
