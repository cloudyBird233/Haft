import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import type { INestApplication } from '@nestjs/common';
import {
  ERROR_CODES,
  RUNNER_PROTOCOL_VERSION,
  runnerServerMessageSchema,
  type ProjectBindingDto,
  type RepositoryValidationPayload,
  type RepositoryValidationResultDto,
  type RunnerServerMessage,
} from '@raft-lite/contracts';
import { createTestApp, waitFor, type ApiSuccessBody } from './test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RunnerRegistryService } from '../src/modules/runners/runner-registry.service';
import { SEED_IDS } from '../src/common/seed/demo-data';

const BOOTSTRAP = 'test-runner-bootstrap-token';
const RUNNER_ID = 'runner_validation_integration';
// Runners/computers survive `/__test__/reset`; use dedicated identities so this
// suite can never collide with the runner on `computer_local` that
// `runner.integration.spec.ts` keeps across runs, and delete them in afterAll.
const COMPUTER_ID = 'computer_repository_validation';
const OTHER_RUNNER_ID = 'runner_repository_validation_other';
const OTHER_COMPUTER_ID = 'computer_repository_validation_other';
const PLATFORM = 'win32';
const REQUIRED_FEATURES = ['repository-validation-v1', 'repository-path-policy-v1'];

interface ConnectedRunner {
  socket: Socket;
  welcome: Extract<RunnerServerMessage, { type: 'runner.welcome' }>;
}

describe('Repository validation integration', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let baseUrl: string;
  let prisma: PrismaService;
  let registry: RunnerRegistryService;
  let activeSockets: Socket[] = [];
  let previousValidationTimeout: string | undefined;
  let previousBootstrapToken: string | undefined;

  beforeAll(async () => {
    // Keep timeout tests fast but inside the production clamp. Environment is
    // restored in afterAll so this suite cannot leak settings to another file.
    previousValidationTimeout = process.env.HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS;
    previousBootstrapToken = process.env.HAFT_RUNNER_BOOTSTRAP_TOKEN;
    process.env.HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS = '5000';
    process.env.HAFT_RUNNER_BOOTSTRAP_TOKEN = BOOTSTRAP;
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    server = app.getHttpServer() as Parameters<typeof request>[0];
    prisma = app.get(PrismaService);
    registry = app.get(RunnerRegistryService);
    await prisma.computer.upsert({
      where: { id: COMPUTER_ID },
      update: { status: 'online' },
      create: {
        id: COMPUTER_ID,
        name: 'Repository Validation Computer',
        hostname: 'repository-validation',
        status: 'online',
      },
    });
  });

  afterAll(async () => {
    for (const socket of activeSockets) socket.disconnect();
    activeSockets = [];
    await delay(100);
    // `/__test__/reset` deliberately preserves runners and computers, so this
    // suite owns its cleanup. Otherwise a persisted validation runner changes
    // the runner list that `runner.integration.spec.ts` asserts on.
    await prisma.runner.deleteMany({
      where: { id: { in: [RUNNER_ID, OTHER_RUNNER_ID] } },
    });
    await prisma.computer.deleteMany({
      where: { id: { in: [COMPUTER_ID, OTHER_COMPUTER_ID] } },
    });
    // This suite temporarily changes the seed project's default branch.
    await prisma.project.updateMany({
      where: { id: SEED_IDS.project },
      data: { defaultBranch: 'main' },
    });
    await app.close();
    if (previousValidationTimeout === undefined) {
      delete process.env.HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS;
    } else {
      process.env.HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS = previousValidationTimeout;
    }
    if (previousBootstrapToken === undefined) {
      delete process.env.HAFT_RUNNER_BOOTSTRAP_TOKEN;
    } else {
      process.env.HAFT_RUNNER_BOOTSTRAP_TOKEN = previousBootstrapToken;
    }
  });

  afterEach(() => {
    for (const socket of activeSockets) socket.disconnect();
    activeSockets = [];
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
        bootstrapToken: options.bootstrapToken ?? BOOTSTRAP,
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
    options: {
      runnerId?: string;
      computerId?: string;
      platform?: string;
      features?: string[];
    } = {},
  ): Promise<void> {
    const runnerId = options.runnerId ?? RUNNER_ID;
    const computerId = options.computerId ?? COMPUTER_ID;
    const platform = options.platform ?? PLATFORM;
    const features = options.features ?? REQUIRED_FEATURES;
    send(
      connected.socket,
      'runner.register',
      {
        computerId,
        runnerVersion: 'test-runner/1.0.0',
        platform,
        architecture: 'x64',
        capabilities: {
          runtimes: [
            {
              runtime: 'codex',
              installed: true,
              version: '0.164.0-test',
              authenticated: true,
              message: null,
            },
          ],
          projectIds: [],
          maxConcurrentExecutions: 1,
          features,
        },
      },
      runnerId,
    );
    send(connected.socket, 'runner.snapshot', { executions: [], pendingLogCount: 0 }, runnerId);
    await waitFor(() => Promise.resolve(Boolean(registry.getLiveRegistration(runnerId))), 4000);
  }

  async function createBinding(path = `/test/repos/${randomUUID()}`): Promise<ProjectBindingDto> {
    const created = await request(server)
      .post(`/api/projects/${SEED_IDS.project}/bindings`)
      .send({ computerId: COMPUTER_ID, path })
      .expect(201);
    return (created.body as ApiSuccessBody<ProjectBindingDto>).data;
  }

  function validate(bindingId: string, projectId: string = SEED_IDS.project) {
    return request(server)
      .post(`/api/projects/${projectId}/bindings/${bindingId}/validate`)
      .send({});
  }

  function respond(
    socket: Socket,
    message: Extract<RunnerServerMessage, { type: 'repository.validate' }>,
    overrides: Partial<RepositoryValidationPayload> = {},
    runnerId = RUNNER_ID,
  ): RepositoryValidationPayload {
    const payload: RepositoryValidationPayload = {
      requestId: message.payload.requestId,
      projectId: message.payload.projectId,
      computerId: message.payload.computerId,
      bindingId: message.payload.bindingId,
      bindingVersion: message.payload.bindingVersion,
      ok: true,
      platform: PLATFORM,
      policyVersion: 'policy-test-v1',
      canonicalPath: '/canonical/repository',
      headCommit: 'a'.repeat(40),
      ...overrides,
    };
    send(socket, 'repository.validation', payload, runnerId);
    return payload;
  }

  it('moves a binding to ready only from a correlated successful validation', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    expect(message.payload).toMatchObject({
      projectId: SEED_IDS.project,
      computerId: COMPUTER_ID,
      bindingId: binding.id,
      bindingVersion: binding.bindingVersion,
      path: binding.path,
    });
    respond(connected.socket, message);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const result = (response.body as ApiSuccessBody<RepositoryValidationResultDto>).data;
    expect(result).toMatchObject({
      status: 'ready',
      canonicalPath: '/canonical/repository',
      platform: PLATFORM,
      policyVersion: 'policy-test-v1',
      headCommit: 'a'.repeat(40),
      errorCode: null,
      message: null,
    });
    expect(result.binding.status).toBe('ready');
    expect(result.binding.validationRequestId).toBeNull();

    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored).toMatchObject({
      status: 'ready',
      canonicalPath: '/canonical/repository',
      platform: PLATFORM,
      policyVersion: 'policy-test-v1',
      validatedByRunnerId: RUNNER_ID,
      validatedBindingVersion: binding.bindingVersion,
      validationRequestId: null,
      validationErrorCode: null,
      validationError: null,
    });
    expect(stored.lastValidatedAt?.toISOString()).toBe(result.validatedAt);
  });

  it('maps REPO_PATH_NOT_FOUND to missing and keeps the configured path', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message, {
      ok: false,
      platform: PLATFORM,
      policyVersion: 'policy-test-v1',
      canonicalPath: undefined,
      headCommit: undefined,
      errorCode: ERROR_CODES.REPO_PATH_NOT_FOUND,
      message: 'Repository path does not exist on the runner host',
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const result = (response.body as ApiSuccessBody<RepositoryValidationResultDto>).data;
    expect(result).toMatchObject({
      status: 'missing',
      canonicalPath: null,
      headCommit: null,
      policyVersion: null,
      errorCode: ERROR_CODES.REPO_PATH_NOT_FOUND,
    });
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored).toMatchObject({
      status: 'missing',
      path: binding.path,
      canonicalPath: null,
      platform: null,
      policyVersion: null,
      validatedByRunnerId: null,
      validatedBindingVersion: null,
      validationRequestId: null,
      validationErrorCode: ERROR_CODES.REPO_PATH_NOT_FOUND,
    });
  });

  it('rejects REPO_DEFAULT_BRANCH_NOT_FOUND from validation as a protocol violation', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message, {
      ok: false,
      canonicalPath: undefined,
      headCommit: undefined,
      errorCode: ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
      message: 'Default branch not found',
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const result = (response.body as ApiSuccessBody<RepositoryValidationResultDto>).data;
    expect(result).toMatchObject({
      status: 'error',
      canonicalPath: null,
      headCommit: null,
      errorCode: ERROR_CODES.REPO_VALIDATION_FAILED,
    });
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('error');
    expect(stored.canonicalPath).toBeNull();
    expect(stored.validationErrorCode).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
    expect(stored.validationRequestId).toBeNull();
  });

  it('rejects REPO_DEFAULT_BRANCH_NOT_FOUND even when the payload claims ok=true', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message, {
      ok: true,
      errorCode: ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND,
      message: 'Default branch not found',
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const result = (response.body as ApiSuccessBody<RepositoryValidationResultDto>).data;
    expect(result).toMatchObject({
      status: 'error',
      canonicalPath: null,
      headCommit: null,
      errorCode: ERROR_CODES.REPO_VALIDATION_FAILED,
    });
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('error');
    expect(stored.canonicalPath).toBeNull();
    expect(stored.validationErrorCode).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
    expect(stored.validationRequestId).toBeNull();
  });

  it('does not consult Project.defaultBranch during path validation', async () => {
    await prisma.project.update({
      where: { id: SEED_IDS.project },
      data: { defaultBranch: 'branch-that-does-not-exist' },
    });
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const result = (response.body as ApiSuccessBody<RepositoryValidationResultDto>).data;
    expect(result.status).toBe('ready');
    expect(result.canonicalPath).toBe('/canonical/repository');
    expect(result.errorCode).toBeNull();

    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('ready');
    expect(stored.validationErrorCode).toBeNull();
  });

  it('maps any other repository error to error', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message, {
      ok: false,
      canonicalPath: undefined,
      headCommit: undefined,
      errorCode: ERROR_CODES.REPO_NOT_GIT_ROOT,
      message: 'Repository path is not the root of a Git repository',
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const result = (response.body as ApiSuccessBody<RepositoryValidationResultDto>).data;
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe(ERROR_CODES.REPO_NOT_GIT_ROOT);

    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('error');
    expect(stored.validationErrorCode).toBe(ERROR_CODES.REPO_NOT_GIT_ROOT);
    expect(stored.validationRequestId).toBeNull();
  });

  it('returns 409 RUNNER_OFFLINE without changing the binding when the runner disconnects', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();
    connected.socket.disconnect();
    await waitFor(
      async () =>
        (await prisma.runner.findUnique({ where: { id: RUNNER_ID } }))?.status === 'offline',
      4000,
    );

    const response = await validate(binding.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ERROR_CODES.RUNNER_OFFLINE);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.validationRequestId).toBeNull();
  });

  it('rejects an old runner without the two live features', async () => {
    const connected = await connectRunner();
    await registerRunner(connected, { features: [] });
    const binding = await createBinding();

    const response = await validate(binding.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ERROR_CODES.RUNNER_FEATURE_UNSUPPORTED);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.validationRequestId).toBeNull();
  });

  it('rejects a runner whose live features are missing even if the database advertises them', async () => {
    const connected = await connectRunner();
    await registerRunner(connected, { features: [] });
    await prisma.runner.update({
      where: { id: RUNNER_ID },
      data: {
        capabilitiesJson: JSON.stringify({
          runtimes: [],
          projectIds: [],
          maxConcurrentExecutions: 1,
          features: REQUIRED_FEATURES,
        }),
      },
    });
    const binding = await createBinding();

    const response = await validate(binding.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ERROR_CODES.RUNNER_FEATURE_UNSUPPORTED);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.validationRequestId).toBeNull();
  });

  it('uses live features even when the persisted capabilities snapshot is empty', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    await prisma.runner.update({
      where: { id: RUNNER_ID },
      data: {
        capabilitiesJson: JSON.stringify({
          runtimes: [],
          projectIds: [],
          maxConcurrentExecutions: 1,
          features: [],
        }),
      },
    });
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('ready');
  });

  it('returns 504 on timeout, keeps status, and discards a late response', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const first = await waitForMessage(connected.socket, 'repository.validate', 5000);
    const retry = await waitForMessage(connected.socket, 'repository.validate', 4000);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.payload).toEqual(first.payload);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe(ERROR_CODES.REPOSITORY_VALIDATION_TIMEOUT);
    let stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.validationRequestId).toBeNull();
    expect(stored.validationErrorCode).toBe(ERROR_CODES.REPOSITORY_VALIDATION_TIMEOUT);
    expect(stored.canonicalPath).toBeNull();

    respond(connected.socket, first);
    await delay(150);
    stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(stored.status).toBe('unverified');
    expect(stored.canonicalPath).toBeNull();
  }, 15_000);

  it('accepts a response after the same-messageId retry', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const first = await waitForMessage(connected.socket, 'repository.validate', 5000);
    const retry = await waitForMessage(connected.socket, 'repository.validate', 4000);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.payload).toEqual(first.payload);
    respond(connected.socket, retry);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('ready');
  }, 15_000);

  it('ignores duplicate and unknown-request responses without changing the row again', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message);
    expect((await responsePromise).status).toBe(200);
    const before = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });

    respond(connected.socket, message);
    send(connected.socket, 'repository.validation', {
      requestId: randomUUID(),
      projectId: message.payload.projectId,
      computerId: message.payload.computerId,
      bindingId: message.payload.bindingId,
      bindingVersion: message.payload.bindingVersion,
      ok: true,
      platform: PLATFORM,
      policyVersion: 'policy-other',
      canonicalPath: '/canonical/unknown',
      headCommit: 'b'.repeat(40),
    });
    await delay(150);

    const after = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(after).toMatchObject({
      status: 'ready',
      canonicalPath: '/canonical/repository',
      policyVersion: 'policy-test-v1',
      validationRequestId: null,
    });
    expect(after.lastValidatedAt?.toISOString()).toBe(before.lastValidatedAt?.toISOString());
  });

  it('rejects an old response after the binding path changed', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    const changed = await request(server)
      .patch(`/api/projects/${SEED_IDS.project}/bindings/${binding.id}`)
      .send({ path: `${binding.path}-moved` })
      .expect(200);
    const changedBinding = (changed.body as ApiSuccessBody<ProjectBindingDto>).data;
    expect(changedBinding.bindingVersion).toBe(binding.bindingVersion + 1);
    respond(connected.socket, message);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ERROR_CODES.BINDING_VERSION_STALE);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored).toMatchObject({
      status: 'unverified',
      path: `${binding.path}-moved`,
      bindingVersion: binding.bindingVersion + 1,
      canonicalPath: null,
      validationRequestId: null,
    });
  });

  it('returns 404 when the binding is deleted while validation is running', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    await request(server)
      .delete(`/api/projects/${SEED_IDS.project}/bindings/${binding.id}`)
      .expect(200);
    respond(connected.socket, message);

    const response = await responsePromise;
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe(ERROR_CODES.BINDING_NOT_FOUND);
    expect(
      await prisma.projectRepositoryBinding.findUnique({ where: { id: binding.id } }),
    ).toBeNull();
  });

  it('uses last-request-wins when two validations race', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const firstResponse = Promise.resolve(validate(binding.id));
    const first = await waitForMessage(connected.socket, 'repository.validate', 5000);
    const secondResponse = Promise.resolve(validate(binding.id));
    const second = await waitForMessage(connected.socket, 'repository.validate', 5000);
    expect(second.payload.requestId).not.toBe(first.payload.requestId);

    respond(connected.socket, first, { canonicalPath: '/canonical/first' });
    const stale = await firstResponse;
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe(ERROR_CODES.BINDING_VERSION_STALE);
    let stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.validationRequestId).toBe(second.payload.requestId);

    respond(connected.socket, second, { canonicalPath: '/canonical/second' });
    const winner = await secondResponse;
    expect(winner.status).toBe(200);
    stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(stored).toMatchObject({
      status: 'ready',
      canonicalPath: '/canonical/second',
      validatedByRunnerId: RUNNER_ID,
      validationRequestId: null,
    });
  });

  it('rejects a response emitted by a different authenticated runner', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);

    const otherComputerId = OTHER_COMPUTER_ID;
    const otherRunnerId = OTHER_RUNNER_ID;
    await prisma.computer.upsert({
      where: { id: otherComputerId },
      update: { status: 'online' },
      create: {
        id: otherComputerId,
        name: 'Validation other computer',
        hostname: 'validation-other',
        status: 'online',
      },
    });
    const other = await connectRunner({
      runnerId: otherRunnerId,
      computerId: otherComputerId,
    });
    await registerRunner(other, { runnerId: otherRunnerId, computerId: otherComputerId });
    respond(other.socket, message, {}, otherRunnerId);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.canonicalPath).toBeNull();
    expect(stored.validationRequestId).toBeNull();
  });

  it('rejects a response whose platform does not match the live connection', async () => {
    const connected = await connectRunner();
    await registerRunner(connected, { platform: PLATFORM });
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    respond(connected.socket, message, { platform: 'linux' });

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.platform).toBeNull();
    expect(stored.validationRequestId).toBeNull();
  });

  it.each(['canonicalPath', 'headCommit'] as const)(
    'treats a successful response without %s as REPO_VALIDATION_FAILED',
    async (field) => {
      const connected = await connectRunner();
      await registerRunner(connected);
      const binding = await createBinding();

      const responsePromise = Promise.resolve(validate(binding.id));
      const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
      respond(connected.socket, message, { [field]: undefined });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      const result = (response.body as ApiSuccessBody<RepositoryValidationResultDto>).data;
      expect(result).toMatchObject({
        status: 'error',
        canonicalPath: null,
        headCommit: null,
        errorCode: ERROR_CODES.REPO_VALIDATION_FAILED,
      });
      const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
        where: { id: binding.id },
      });
      expect(stored.status).toBe('error');
      expect(stored.canonicalPath).toBeNull();
      expect(stored.validationErrorCode).toBe(ERROR_CODES.REPO_VALIDATION_FAILED);
      expect(stored.validationRequestId).toBeNull();
    },
  );

  it('drops a successful response without platform at the protocol schema', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const binding = await createBinding();

    const responsePromise = Promise.resolve(validate(binding.id));
    const message = await waitForMessage(connected.socket, 'repository.validate', 5000);
    // `platform` is required by `repositoryValidationPayloadSchema`, so the
    // gateway drops the malformed message and the request times out. The
    // API-level `platform` guard still protects typed callers.
    respond(connected.socket, message, { platform: undefined });

    const response = await responsePromise;
    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe(ERROR_CODES.REPOSITORY_VALIDATION_TIMEOUT);
    const stored = await prisma.projectRepositoryBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(stored.status).toBe('unverified');
    expect(stored.canonicalPath).toBeNull();
    expect(stored.validationRequestId).toBeNull();
  }, 15_000);

  it('returns 404 for an unknown project or binding', async () => {
    const missingProject = await validate('binding_missing', 'project_missing');
    expect(missingProject.status).toBe(404);
    expect(missingProject.body.error.code).toBe(ERROR_CODES.PROJECT_NOT_FOUND);

    const missingBinding = await validate('binding_missing');
    expect(missingBinding.status).toBe(404);
    expect(missingBinding.body.error.code).toBe(ERROR_CODES.BINDING_NOT_FOUND);
  });

  it('never sends runner messages for binding create, update or delete', async () => {
    const connected = await connectRunner();
    await registerRunner(connected);
    const received: string[] = [];
    const handler = (raw: unknown): void => {
      const parsed = runnerServerMessageSchema.safeParse(raw);
      if (parsed.success) received.push(parsed.data.type);
    };
    connected.socket.on('runner.message', handler);
    try {
      const binding = await createBinding();
      await request(server)
        .patch(`/api/projects/${SEED_IDS.project}/bindings/${binding.id}`)
        .send({ path: `${binding.path}-moved` })
        .expect(200);
      await request(server)
        .delete(`/api/projects/${SEED_IDS.project}/bindings/${binding.id}`)
        .expect(200);
      await delay(200);
    } finally {
      connected.socket.off('runner.message', handler);
    }
    expect(received).toEqual([]);
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
