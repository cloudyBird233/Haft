import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type {
  ActivityDto,
  AgentDetailDto,
  AgentDto,
  DashboardDto,
  ExecutionDto,
  ExecutionLogDto,
  ListDto,
  TaskDetailDto,
  TaskDto,
} from '@raft-lite/contracts';
import { MockRuntimeService } from '../src/modules/runtime/mock-runtime.service';
import { createTestApp, waitFor, type ApiSuccessBody } from './test-app';

describe('Raft Lite API integration', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const response = await request(server).post('/__test__/reset').send({});
    expect(response.status).toBe(200);
  });

  it('reports health with a request id envelope', async () => {
    const response = await request(server).get('/api/health').expect(200);
    const body = response.body as ApiSuccessBody<{ status: string; database: string }>;
    expect(body.data.status).toBe('ok');
    expect(body.data.database).toBe('up');
    expect(body.requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBe(body.requestId);
  });

  it('validates input and returns a structured error', async () => {
    const response = await request(server).post('/api/agents').send({ name: 'A' }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'role' })]),
    );
    expect(response.body.requestId).toBeTruthy();
  });

  it('returns 404 for a missing resource', async () => {
    const response = await request(server).get('/api/agents/does_not_exist').expect(404);
    expect(response.body.error.code).toBe('AGENT_NOT_FOUND');
  });

  it('creates, reads, updates, searches, and deletes an agent', async () => {
    const created = await request(server)
      .post('/api/agents')
      .send({
        name: 'Reviewer',
        role: 'Code Reviewer',
        description: 'Review pull requests against platform conventions.',
        runtime: 'mock',
        computerId: 'computer_local',
      })
      .expect(201);
    const agent = (created.body as ApiSuccessBody<AgentDto>).data;
    expect(agent.name).toBe('Reviewer');
    expect(agent.status).toBe('idle');
    expect(agent.computer?.name).toBe('Local Workstation');

    const searched = await request(server).get('/api/agents?search=reviewer').expect(200);
    expect((searched.body as ApiSuccessBody<ListDto<AgentDto>>).data.total).toBe(1);

    const updated = await request(server)
      .patch(`/api/agents/${agent.id}`)
      .send({ role: 'Security Reviewer', status: 'offline' })
      .expect(200);
    expect((updated.body as ApiSuccessBody<AgentDto>).data.role).toBe('Security Reviewer');
    expect((updated.body as ApiSuccessBody<AgentDto>).data.status).toBe('offline');

    const detail = await request(server).get(`/api/agents/${agent.id}`).expect(200);
    expect((detail.body as ApiSuccessBody<AgentDetailDto>).data.recentExecutions).toHaveLength(0);

    await request(server).delete(`/api/agents/${agent.id}`).expect(200);
    await request(server).get(`/api/agents/${agent.id}`).expect(404);

    const activities = await request(server).get('/api/activities?limit=100').expect(200);
    const types = (activities.body as ApiSuccessBody<ListDto<ActivityDto>>).data.items.map(
      (activity) => activity.type,
    );
    expect(types).toEqual(
      expect.arrayContaining(['agent.created', 'agent.updated', 'agent.deleted']),
    );
  });

  it('resets active tasks when their agent is deleted without touching other agents', async () => {
    const created = await request(server)
      .post('/api/agents')
      .send({
        name: 'Temporary Worker',
        role: 'Task Owner',
        description: 'Exercises deletion cleanup for active tasks.',
      })
      .expect(201);
    const agent = (created.body as ApiSuccessBody<AgentDto>).data;

    const claimedTask = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Claimed work owned by the temporary agent',
        projectId: 'project_demo',
        assigneeAgentId: agent.id,
      })
      .expect(201);
    const claimed = (claimedTask.body as ApiSuccessBody<TaskDto>).data;

    const inProgressTask = await request(server)
      .post('/api/tasks')
      .send({
        title: 'In-progress work owned by the temporary agent',
        projectId: 'project_demo',
        assigneeAgentId: agent.id,
      })
      .expect(201);
    const inProgress = (inProgressTask.body as ApiSuccessBody<TaskDto>).data;
    await request(server)
      .patch(`/api/tasks/${inProgress.id}`)
      .send({ status: 'in_progress' })
      .expect(200);

    const otherAgentTask = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Control task owned by another agent',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_developer',
      })
      .expect(201);
    const control = (otherAgentTask.body as ApiSuccessBody<TaskDto>).data;

    await request(server).delete(`/api/agents/${agent.id}`).expect(200);

    for (const taskId of [claimed.id, inProgress.id]) {
      const task = await request(server).get(`/api/tasks/${taskId}`).expect(200);
      const data = (task.body as ApiSuccessBody<TaskDetailDto>).data;
      expect(data.status).toBe('todo');
      expect(data.assignee).toBeNull();
    }

    const controlAfter = await request(server).get(`/api/tasks/${control.id}`).expect(200);
    expect((controlAfter.body as ApiSuccessBody<TaskDetailDto>).data).toMatchObject({
      status: 'claimed',
      assignee: expect.objectContaining({ id: 'agent_developer' }),
    });
  });

  it('persists task assignment and rejects invalid state transitions', async () => {
    const created = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Wire the audit trail',
        description: 'Add structured activity records.',
        projectId: 'project_demo',
        priority: 'high',
      })
      .expect(201);
    const task = (created.body as ApiSuccessBody<TaskDto>).data;
    expect(task.status).toBe('todo');
    expect(task.assignee).toBeNull();

    const assigned = await request(server)
      .post(`/api/tasks/${task.id}/assign`)
      .send({ agentId: 'agent_developer' })
      .expect(200);
    expect((assigned.body as ApiSuccessBody<TaskDto>).data.status).toBe('claimed');

    const invalid = await request(server)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'done' })
      .expect(409);
    expect(invalid.body.error.code).toBe('INVALID_TASK_TRANSITION');

    const detail = await request(server).get(`/api/tasks/${task.id}`).expect(200);
    expect((detail.body as ApiSuccessBody<TaskDetailDto>).data.assignee?.id).toBe(
      'agent_developer',
    );

    const reopened = await request(server)
      .patch(`/api/tasks/${task.id}`)
      .send({ title: 'Wire the structured audit trail' })
      .expect(200);
    expect((reopened.body as ApiSuccessBody<TaskDto>).data.title).toContain('structured');

    const dashboard = await request(server).get('/api/dashboard').expect(200);
    expect((dashboard.body as ApiSuccessBody<DashboardDto>).data.metrics.tasksTotal).toBe(5);
  });

  it('runs a deterministic mock execution, streams state, and completes it', async () => {
    await request(server).post('/__test__/runtime/mode').send({ mode: 'manual' }).expect(200);
    const created = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Exercise the deterministic runtime',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_developer',
        priority: 'urgent',
      })
      .expect(201);
    const task = (created.body as ApiSuccessBody<TaskDto>).data;

    const started = await request(server).post(`/api/tasks/${task.id}/start`).expect(201);
    const execution = (started.body as ApiSuccessBody<ExecutionDto>).data;
    expect(execution.status).toBe('running');

    const taskWhileRunning = await request(server).get(`/api/tasks/${task.id}`).expect(200);
    expect((taskWhileRunning.body as ApiSuccessBody<TaskDetailDto>).data.status).toBe(
      'in_progress',
    );

    const agentWhileRunning = await request(server).get('/api/agents/agent_developer').expect(200);
    expect((agentWhileRunning.body as ApiSuccessBody<AgentDetailDto>).data.status).toBe('busy');

    await request(server)
      .post(`/__test__/executions/${execution.id}/advance`)
      .send({ steps: 2 })
      .expect(200);

    await waitFor(async () => {
      const result = await request(server).get(`/api/executions/${execution.id}`);
      return (result.body as ApiSuccessBody<ExecutionDto>).data.progress >= 40;
    });

    await waitFor(async () => {
      const logs = await request(server).get(`/api/executions/${execution.id}/logs?limit=100`);
      return (logs.body as ApiSuccessBody<ListDto<ExecutionLogDto>>).data.items.length >= 2;
    });

    await request(server)
      .post(`/__test__/executions/${execution.id}/finish`)
      .send({ outcome: 'success' })
      .expect(200);

    const completed = await waitFor(async () => {
      const result = await request(server).get(`/api/executions/${execution.id}`);
      const data = (result.body as ApiSuccessBody<ExecutionDto>).data;
      return data.status === 'completed' ? data : null;
    });
    expect(completed.progress).toBe(100);

    const finishedTask = await request(server).get(`/api/tasks/${task.id}`).expect(200);
    expect((finishedTask.body as ApiSuccessBody<TaskDetailDto>).data.status).toBe('done');
    const finishedAgent = await request(server).get('/api/agents/agent_developer').expect(200);
    expect((finishedAgent.body as ApiSuccessBody<AgentDetailDto>).data.status).toBe('idle');

    const logs = await request(server).get(`/api/executions/${execution.id}/logs?limit=100`);
    const logItems = (logs.body as ApiSuccessBody<ListDto<ExecutionLogDto>>).data.items;
    expect(logItems.some((log) => log.level === 'success')).toBe(true);
    expect(logItems.every((log, index) => index === 0 || log.seq > logItems[index - 1]!.seq)).toBe(
      true,
    );
  });

  it('allows only one of two concurrent starts for the same task', async () => {
    await request(server).post('/__test__/runtime/mode').send({ mode: 'manual' }).expect(200);
    const created = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Guard against double execution starts',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_developer',
      })
      .expect(201);
    const task = (created.body as ApiSuccessBody<TaskDto>).data;

    const first = request(server).post(`/api/tasks/${task.id}/start`).send({});
    const second = request(server).post(`/api/tasks/${task.id}/start`).send({});
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const statuses = [firstResponse.status, secondResponse.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const conflict = firstResponse.status === 409 ? firstResponse : secondResponse;
    expect(conflict.body.error.code).toBe('EXECUTION_ALREADY_RUNNING');

    const executions = await request(server).get(`/api/executions?taskId=${task.id}`).expect(200);
    expect((executions.body as ApiSuccessBody<ListDto<ExecutionDto>>).data.total).toBe(1);
  });

  it('allows only one of two concurrent starts for the same agent', async () => {
    await request(server).post('/__test__/runtime/mode').send({ mode: 'manual' }).expect(200);
    const firstTask = await request(server)
      .post('/api/tasks')
      .send({
        title: 'First concurrent task for one agent',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_qa',
      })
      .expect(201);
    const secondTask = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Second concurrent task for one agent',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_qa',
      })
      .expect(201);
    const firstTaskId = (firstTask.body as ApiSuccessBody<TaskDto>).data.id;
    const secondTaskId = (secondTask.body as ApiSuccessBody<TaskDto>).data.id;

    const first = request(server).post(`/api/tasks/${firstTaskId}/start`).send({});
    const second = request(server).post(`/api/tasks/${secondTaskId}/start`).send({});
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const statuses = [firstResponse.status, secondResponse.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const conflict = firstResponse.status === 409 ? firstResponse : secondResponse;
    expect(conflict.body.error.code).toBe('AGENT_BUSY');

    const executions = await request(server).get('/api/executions?agentId=agent_qa').expect(200);
    expect((executions.body as ApiSuccessBody<ListDto<ExecutionDto>>).data.total).toBe(1);
  });

  it('rolls back task and agent state when the runtime cannot start', async () => {
    await request(server).post('/__test__/runtime/mode').send({ mode: 'manual' }).expect(200);
    const created = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Recover from a runtime start failure',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_architect',
      })
      .expect(201);
    const task = (created.body as ApiSuccessBody<TaskDto>).data;

    const runtime = app.get(MockRuntimeService);
    const startSpy = vi
      .spyOn(runtime, 'start')
      .mockRejectedValueOnce(new Error('adapter unavailable'));
    const response = await request(server).post(`/api/tasks/${task.id}/start`).send({});
    startSpy.mockRestore();
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('RUNTIME_START_FAILED');

    const executions = await request(server).get(`/api/executions?taskId=${task.id}`).expect(200);
    const items = (executions.body as ApiSuccessBody<ListDto<ExecutionDto>>).data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('failed to start'),
    });

    const taskAfter = await request(server).get(`/api/tasks/${task.id}`).expect(200);
    expect((taskAfter.body as ApiSuccessBody<TaskDetailDto>).data).toMatchObject({
      status: 'claimed',
      assignee: expect.objectContaining({ id: 'agent_architect' }),
    });
    const agentAfter = await request(server).get('/api/agents/agent_architect').expect(200);
    expect((agentAfter.body as ApiSuccessBody<AgentDetailDto>).data.status).toBe('idle');

    const logs = await request(server)
      .get(`/api/executions/${items[0]!.id}/logs?limit=100`)
      .expect(200);
    expect(
      (logs.body as ApiSuccessBody<ListDto<ExecutionLogDto>>).data.items.some(
        (log) => log.level === 'error',
      ),
    ).toBe(true);

    await request(server).post(`/api/tasks/${task.id}/start`).send({}).expect(201);
  });

  it('cancels a running execution and returns the agent to idle', async () => {
    await request(server).post('/__test__/runtime/mode').send({ mode: 'manual' }).expect(200);
    const created = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Cancel a long running operation',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_qa',
      })
      .expect(201);
    const task = (created.body as ApiSuccessBody<TaskDto>).data;
    const started = await request(server).post(`/api/tasks/${task.id}/start`).expect(201);
    const execution = (started.body as ApiSuccessBody<ExecutionDto>).data;

    const cancelled = await request(server)
      .post(`/api/executions/${execution.id}/cancel`)
      .send({ reason: 'Integration test cancellation' })
      .expect(200);
    expect((cancelled.body as ApiSuccessBody<ExecutionDto>).data.status).toBe('cancelled');

    const taskAfter = await request(server).get(`/api/tasks/${task.id}`).expect(200);
    expect((taskAfter.body as ApiSuccessBody<TaskDetailDto>).data.status).toBe('cancelled');
    const agentAfter = await request(server).get('/api/agents/agent_qa').expect(200);
    expect((agentAfter.body as ApiSuccessBody<AgentDetailDto>).data.status).toBe('idle');

    const cancelAgain = await request(server)
      .post(`/api/executions/${execution.id}/cancel`)
      .send({})
      .expect(409);
    expect(cancelAgain.body.error.code).toBe('EXECUTION_NOT_RUNNING');
  });

  it('handles runtime failure and blocks a busy agent from deletion', async () => {
    await request(server).post('/__test__/runtime/mode').send({ mode: 'manual' }).expect(200);
    const created = await request(server)
      .post('/api/tasks')
      .send({
        title: 'Trigger a deterministic failure',
        projectId: 'project_demo',
        assigneeAgentId: 'agent_architect',
      })
      .expect(201);
    const task = (created.body as ApiSuccessBody<TaskDto>).data;
    const started = await request(server).post(`/api/tasks/${task.id}/start`).expect(201);
    const execution = (started.body as ApiSuccessBody<ExecutionDto>).data;

    const busyDelete = await request(server).delete('/api/agents/agent_architect').expect(409);
    expect(busyDelete.body.error.code).toBe('AGENT_BUSY');

    await request(server)
      .post(`/__test__/executions/${execution.id}/finish`)
      .send({ outcome: 'failure', reason: 'Validation gate failed in test' })
      .expect(200);

    const failed = await waitFor(async () => {
      const result = await request(server).get(`/api/executions/${execution.id}`);
      const data = (result.body as ApiSuccessBody<ExecutionDto>).data;
      return data.status === 'failed' ? data : null;
    });
    expect(failed.failureReason).toContain('Validation gate failed');
    const taskAfter = await request(server).get(`/api/tasks/${task.id}`).expect(200);
    expect((taskAfter.body as ApiSuccessBody<TaskDetailDto>).data.status).toBe('failed');
    const agentAfter = await request(server).get('/api/agents/agent_architect').expect(200);
    expect((agentAfter.body as ApiSuccessBody<AgentDetailDto>).data.status).toBe('error');

    await request(server).delete('/api/agents/agent_architect').expect(200);
  });

  it('supports an empty deterministic seed and restores the default seed', async () => {
    await request(server).post('/__test__/seed').send({ preset: 'empty' }).expect(200);
    const tasks = await request(server).get('/api/tasks').expect(200);
    expect((tasks.body as ApiSuccessBody<ListDto<TaskDto>>).data.total).toBe(0);
    const agents = await request(server).get('/api/agents').expect(200);
    expect((agents.body as ApiSuccessBody<ListDto<AgentDto>>).data.total).toBe(3);

    await request(server).post('/__test__/reset').send({}).expect(200);
    const restored = await request(server).get('/api/tasks').expect(200);
    expect((restored.body as ApiSuccessBody<ListDto<TaskDto>>).data.total).toBe(4);
  });

  it('exposes generated OpenAPI documentation', async () => {
    const response = await request(server).get('/api/docs-json').expect(200);
    expect(response.body).toMatchObject({
      openapi: expect.stringContaining('3.'),
      info: expect.objectContaining({ title: 'Raft Lite API' }),
    });
    expect(response.body.paths['/api/agents']).toBeTruthy();
  });
});
