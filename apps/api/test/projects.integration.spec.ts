import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  ERROR_CODES,
  type ListDto,
  type ProjectBindingDto,
  type ProjectDetailDto,
  type ProjectDto,
  type TaskDto,
} from '@raft-lite/contracts';
import { createTestApp, type ApiSuccessBody } from './test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { EventsGateway } from '../src/modules/events/events.gateway';

describe('Projects and repository bindings API', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let prisma: PrismaService;
  let events: { emitTaskUpdated: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer() as Parameters<typeof request>[0];
    prisma = app.get(PrismaService);
    events = app.get(EventsGateway) as unknown as typeof events;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const response = await request(server).post('/__test__/reset').send({});
    expect(response.status).toBe(200);
    events.emitTaskUpdated.mockClear();
  });

  async function createProject(body: Record<string, unknown>): Promise<ProjectDto> {
    const response = await request(server).post('/api/projects').send(body).expect(201);
    return (response.body as ApiSuccessBody<ProjectDto>).data;
  }

  /**
   * Test-only interleaving point. The first Project read in a request is the
   * service's precheck; archive the project immediately after that read
   * returns, so the write transaction must reject it. No product code is
   * aware of this hook.
   */
  function archiveAfterNextProjectRead(projectId: string): {
    wasArchived: () => boolean;
    restore: () => void;
  } {
    type FindFirst = (args: unknown) => Promise<{ id: string } | null>;
    const delegate = prisma.project as unknown as { findFirst: FindFirst };
    const original = delegate.findFirst;
    let archived = false;
    delegate.findFirst = async (args) => {
      const project = await original.call(prisma.project, args);
      if (!archived && project?.id === projectId) {
        archived = true;
        await prisma.project.update({
          where: { id: projectId },
          data: { archivedAt: new Date() },
        });
      }
      return project;
    };
    return {
      wasArchived: () => archived,
      restore: () => {
        delegate.findFirst = original;
      },
    };
  }

  it('creates, lists, updates, archives, and deletes projects with counts', async () => {
    const project = await createProject({
      key: 'haft',
      name: 'Haft Platform',
      description: 'Phase 2 project management',
      defaultBranch: 'develop',
    });
    expect(project).toMatchObject({
      workspaceId: 'ws_demo',
      key: 'HAFT',
      name: 'Haft Platform',
      defaultBranch: 'develop',
      archivedAt: null,
      taskCount: 0,
      executionCount: 0,
      bindingCount: 0,
    });
    expect(project).not.toHaveProperty('repoUrl');
    expect(project.updatedAt).toBeTruthy();

    const duplicate = await request(server)
      .post('/api/projects')
      .send({ key: 'Haft', name: 'Duplicate' })
      .expect(409);
    expect(duplicate.body.error.code).toBe('PROJECT_KEY_CONFLICT');

    const task = await request(server)
      .post('/api/tasks')
      .send({ title: 'Belongs to the new project', projectId: project.id })
      .expect(201);
    expect((task.body as ApiSuccessBody<TaskDto>).data.projectId).toBe(project.id);

    const list = await request(server).get('/api/projects').expect(200);
    const items = (list.body as ApiSuccessBody<ListDto<ProjectDto>>).data.items;
    expect(items.find((item) => item.id === project.id)).toMatchObject({
      taskCount: 1,
      executionCount: 0,
      bindingCount: 0,
    });

    const detail = await request(server).get(`/api/projects/${project.id}`).expect(200);
    expect((detail.body as ApiSuccessBody<ProjectDetailDto>).data.bindings).toEqual([]);

    const updated = await request(server)
      .patch(`/api/projects/${project.id}`)
      .send({
        name: 'Haft Platform v2',
        description: '',
        defaultBranch: 'release/2026',
      })
      .expect(200);
    expect((updated.body as ApiSuccessBody<ProjectDetailDto>).data).toMatchObject({
      name: 'Haft Platform v2',
      description: '',
      defaultBranch: 'release/2026',
    });

    const keyChange = await request(server)
      .patch(`/api/projects/${project.id}`)
      .send({ key: 'OTHER' })
      .expect(400);
    expect(keyChange.body.error.code).toBe('VALIDATION_ERROR');

    const archived = await request(server)
      .patch(`/api/projects/${project.id}`)
      .send({ archived: true })
      .expect(200);
    expect((archived.body as ApiSuccessBody<ProjectDetailDto>).data.archivedAt).toBeTruthy();

    const blocked = await request(server)
      .post('/api/tasks')
      .send({ title: 'Archived project must reject tasks', projectId: project.id })
      .expect(409);
    expect(blocked.body.error.code).toBe('PROJECT_ARCHIVED');

    const restored = await request(server)
      .patch(`/api/projects/${project.id}`)
      .send({ archived: false })
      .expect(200);
    expect((restored.body as ApiSuccessBody<ProjectDetailDto>).data.archivedAt).toBeNull();

    const withTasks = await request(server).delete(`/api/projects/${project.id}`).expect(409);
    expect(withTasks.body.error.code).toBe('PROJECT_HAS_TASKS');

    const empty = await createProject({ key: 'EMPTY', name: 'Empty Project' });
    await request(server).delete(`/api/projects/${empty.id}`).expect(200);
    await request(server).get(`/api/projects/${empty.id}`).expect(404);
  });

  it('validates project input and rejects unknown fields', async () => {
    for (const body of [
      { key: '1BAD', name: 'Invalid key' },
      { key: 'OK', name: 'x' },
      // P2-02 display metadata is not part of the frozen P2-01 project schema.
      { key: 'OK', name: 'Valid name', repoUrl: 'git@github.com:org/repo.git' },
      { key: 'OK', name: 'Valid name', defaultBranch: 'release 1' },
      { key: 'OK', name: 'Valid name', color: 'red' },
      { key: 'OK', name: 'Valid name', archivedAt: null },
    ]) {
      const response = await request(server).post('/api/projects').send(body).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const project = await createProject({ key: 'VALID', name: 'Valid project' });
    await request(server).patch(`/api/projects/${project.id}`).send({}).expect(400);
    await request(server)
      .patch(`/api/projects/${project.id}`)
      .send({ archivedAt: null })
      .expect(400);
    await request(server).get('/api/projects/project_missing').expect(404);
  });

  it('manages bindings with raw paths, stable hashes, and immutable fields', async () => {
    const project = await createProject({ key: 'BIND', name: 'Binding Project' });
    const otherProject = await createProject({ key: 'OTHER', name: 'Other Project' });
    await prisma.computer.upsert({
      where: { id: 'computer_projects_extra' },
      update: {},
      create: {
        id: 'computer_projects_extra',
        name: 'Secondary Workstation',
        hostname: 'secondary',
        status: 'online',
      },
    });

    const rawPath = 'C:\\Work\\Repos\\Haft Repo';
    const created = await request(server)
      .post(`/api/projects/${project.id}/bindings`)
      .send({ computerId: 'computer_local', path: rawPath })
      .expect(201);
    const binding = (created.body as ApiSuccessBody<ProjectBindingDto>).data;
    expect(binding).toMatchObject({
      projectId: project.id,
      computerId: 'computer_local',
      path: rawPath,
      bindingVersion: 1,
      status: 'unverified',
      canonicalPath: null,
      lastValidatedAt: null,
      validatedByRunnerId: null,
      validatedBindingVersion: null,
    });
    expect(binding.pathHash).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.computer?.id).toBe('computer_local');

    const duplicate = await request(server)
      .post(`/api/projects/${project.id}/bindings`)
      .send({ computerId: 'computer_local', path: '/srv/other' })
      .expect(409);
    expect(duplicate.body.error.code).toBe('BINDING_DUPLICATE_COMPUTER');

    const second = await request(server)
      .post(`/api/projects/${project.id}/bindings`)
      .send({ computerId: 'computer_projects_extra', path: rawPath })
      .expect(201);
    const secondBinding = (second.body as ApiSuccessBody<ProjectBindingDto>).data;
    expect(secondBinding.pathHash).toBe(binding.pathHash);

    const changedPath = 'C:\\Work\\Repos\\Renamed';
    const updated = await request(server)
      .patch(`/api/projects/${project.id}/bindings/${binding.id}`)
      .send({ path: changedPath })
      .expect(200);
    const changed = (updated.body as ApiSuccessBody<ProjectBindingDto>).data;
    expect(changed).toMatchObject({
      path: changedPath,
      bindingVersion: 2,
      status: 'unverified',
    });
    expect(changed.pathHash).not.toBe(binding.pathHash);

    const unchanged = await request(server)
      .patch(`/api/projects/${project.id}/bindings/${binding.id}`)
      .send({ path: changedPath })
      .expect(200);
    expect((unchanged.body as ApiSuccessBody<ProjectBindingDto>).data.bindingVersion).toBe(2);

    for (const body of [
      { defaultBranch: 'main' },
      { status: 'ready' },
      { computerId: 'computer_projects_extra' },
      { pathHash: 'forged' },
      { canonicalPath: '/fake' },
      { id: 'forged' },
    ]) {
      const response = await request(server)
        .patch(`/api/projects/${project.id}/bindings/${binding.id}`)
        .send(body)
        .expect(400);
      expect(response.body.error.code).toBe('BINDING_FIELD_IMMUTABLE');
    }

    const unknown = await request(server)
      .patch(`/api/projects/${project.id}/bindings/${binding.id}`)
      .send({ paths: '/typo' })
      .expect(400);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');

    const wrongProject = await request(server)
      .patch(`/api/projects/${otherProject.id}/bindings/${binding.id}`)
      .send({ path: '/srv/repo' })
      .expect(404);
    expect(wrongProject.body.error.code).toBe('BINDING_NOT_FOUND');
    await request(server)
      .delete(`/api/projects/${otherProject.id}/bindings/${binding.id}`)
      .expect(404);

    const list = await request(server).get(`/api/projects/${project.id}/bindings`).expect(200);
    expect((list.body as ApiSuccessBody<ListDto<ProjectBindingDto>>).data.total).toBe(2);

    await request(server)
      .delete(`/api/projects/${project.id}/bindings/${secondBinding.id}`)
      .expect(200);
    const after = await request(server).get(`/api/projects/${project.id}/bindings`).expect(200);
    expect((after.body as ApiSuccessBody<ListDto<ProjectBindingDto>>).data.total).toBe(1);
    const detail = await request(server).get(`/api/projects/${project.id}`).expect(200);
    expect((detail.body as ApiSuccessBody<ProjectDetailDto>).data.bindingCount).toBe(1);
  });

  it('exposes repository validation as an explicit route with no runner side effect', async () => {
    const project = await createProject({ key: 'NORUN', name: 'No Runner Project' });
    const created = await request(server)
      .post(`/api/projects/${project.id}/bindings`)
      .send({ computerId: 'computer_local', path: '/srv/repo' })
      .expect(201);
    const binding = (created.body as ApiSuccessBody<ProjectBindingDto>).data;

    expect(binding.status).toBe('unverified');
    const validation = await request(server)
      .post(`/api/projects/${project.id}/bindings/${binding.id}/validate`)
      .send({})
      .expect(409);
    expect(validation.body.error.code).toBe(ERROR_CODES.RUNNER_OFFLINE);
    const after = await request(server).get(`/api/projects/${project.id}`).expect(200);
    expect((after.body as ApiSuccessBody<ProjectDetailDto>).data.bindings[0]).toMatchObject({
      status: 'unverified',
      validatedBindingVersion: null,
      validationRequestId: null,
    });
  });

  it('rejects execution start for an archived project without side effects', async () => {
    const project = await createProject({ key: 'ARCH', name: 'Archived Execution Project' });
    const createdAgent = await request(server)
      .post('/api/agents')
      .send({
        name: 'Archive Guard Agent',
        role: 'Archive Guard',
        runtime: 'codex',
        computerId: 'computer_local',
      })
      .expect(201);
    const agent = (createdAgent.body as ApiSuccessBody<{ id: string }>).data;
    const createdTask = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Archived project execution guard',
        projectId: project.id,
        assigneeAgentId: agent.id,
      })
      .expect(201);
    const task = (createdTask.body as ApiSuccessBody<TaskDto>).data;

    await request(server).patch(`/api/projects/${project.id}`).send({ archived: true }).expect(200);

    const blocked = await request(server).post(`/api/tasks/${task.id}/start`).send({}).expect(409);
    expect(blocked.body.error.code).toBe('PROJECT_ARCHIVED');

    expect(await prisma.execution.count({ where: { taskId: task.id } })).toBe(0);
    const taskAfter = await request(server).get(`/api/tasks/${task.id}`).expect(200);
    expect((taskAfter.body as ApiSuccessBody<TaskDto>).data).toMatchObject({
      status: task.status,
      latestExecution: null,
    });
    const agentAfter = await request(server).get(`/api/agents/${agent.id}`).expect(200);
    expect((agentAfter.body as ApiSuccessBody<{ status: string }>).data.status).toBe('idle');
  });

  it('rejects task creation when the project is archived between precheck and insert', async () => {
    const project = await createProject({ key: 'RACE', name: 'Task Creation Race' });
    const beforeActivityCount = await prisma.activity.count();
    events.emitTaskUpdated.mockClear();

    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).archivedAt).toBe(
      null,
    );
    const hook = archiveAfterNextProjectRead(project.id);

    let response;
    try {
      response = await request(server)
        .post('/api/tasks')
        .send({
          title: 'Must not survive the archive race',
          projectId: project.id,
          assigneeAgentId: 'agent_developer',
        })
        .expect(409);
    } finally {
      hook.restore();
    }
    expect(response.body.error.code).toBe('PROJECT_ARCHIVED');
    // The precheck observed an active project; only the transaction re-read
    // saw the archive that landed in between.
    expect(hook.wasArchived()).toBe(true);

    expect(await prisma.task.count({ where: { title: 'Must not survive the archive race' } })).toBe(
      0,
    );
    expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.activity.count()).toBe(beforeActivityCount);
    expect(events.emitTaskUpdated).not.toHaveBeenCalled();
  });

  it('rejects moving a task when the target project is archived between precheck and update', async () => {
    const source = await createProject({ key: 'SRC', name: 'Source Project' });
    const target = await createProject({ key: 'TGT', name: 'Target Project' });
    const created = await request(server)
      .post('/api/tasks')
      .send({ title: 'Keep me in the source project', projectId: source.id })
      .expect(201);
    const task = (created.body as ApiSuccessBody<TaskDto>).data;
    const beforeActivityCount = await prisma.activity.count();
    events.emitTaskUpdated.mockClear();

    expect((await prisma.project.findUniqueOrThrow({ where: { id: target.id } })).archivedAt).toBe(
      null,
    );
    const hook = archiveAfterNextProjectRead(target.id);

    let response;
    try {
      response = await request(server)
        .patch(`/api/tasks/${task.id}`)
        .send({ projectId: target.id })
        .expect(409);
    } finally {
      hook.restore();
    }
    expect(response.body.error.code).toBe('PROJECT_ARCHIVED');
    expect(hook.wasArchived()).toBe(true);

    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.projectId).toBe(source.id);
    expect(await prisma.task.count({ where: { projectId: target.id } })).toBe(0);
    expect(await prisma.activity.count()).toBe(beforeActivityCount);
    expect(events.emitTaskUpdated).not.toHaveBeenCalled();
  });

  it('hides projects that belong to another workspace', async () => {
    await prisma.workspace.upsert({
      where: { id: 'ws_other' },
      update: {},
      create: { id: 'ws_other', name: 'Other', slug: 'other' },
    });
    const foreign = await prisma.project.create({
      data: {
        id: 'project_foreign',
        workspaceId: 'ws_other',
        key: 'FOREIGN',
        name: 'Foreign Project',
      },
    });

    for (const path of [`/api/projects/${foreign.id}`, `/api/projects/${foreign.id}/bindings`]) {
      const response = await request(server).get(path).expect(404);
      expect(response.body.error.code).toBe('PROJECT_NOT_FOUND');
    }
    const patched = await request(server)
      .patch(`/api/projects/${foreign.id}`)
      .send({ name: 'Hijacked' })
      .expect(404);
    expect(patched.body.error.code).toBe('PROJECT_NOT_FOUND');
    await request(server).delete(`/api/projects/${foreign.id}`).expect(404);
    await request(server)
      .post(`/api/projects/${foreign.id}/bindings`)
      .send({ computerId: 'computer_local', path: '/srv/repo' })
      .expect(404);
  });
});
