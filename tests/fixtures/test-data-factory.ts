import type { APIRequestContext, APIResponse } from '@playwright/test';
import type {
  AdvanceExecutionResult,
  AgentDetailDto,
  AgentDto,
  ApiErrorBody,
  ApiSuccess,
  CreateAgentInput,
  CreateTaskInput,
  ExecutionDiffDto,
  ExecutionDto,
  ExecutionLogDto,
  FinishExecutionResult,
  ListDto,
  RuntimeAvailabilityDto,
  RuntimeControlMode,
  RuntimeFinishOutcome,
  TaskCancellationDto,
  TaskDetailDto,
  TaskDto,
  TestResetResult,
  TestSeedPreset,
  UpdateAgentInput,
  UpdateTaskInput,
} from '@raft-lite/contracts';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface TestFactoryOptions {
  apiBaseUrl?: string;
}

/**
 * Test data factory backed by the real REST API.
 *
 * Every factory call creates ordinary domain data (no direct database writes),
 * so the fixtures exercise the same validation, state machine, activity and
 * socket paths as the UI.
 */
export class RaftTestFactory {
  private readonly apiBaseUrl: string;
  private readonly runId = Date.now().toString(36);
  private sequence = 0;

  constructor(
    private readonly request: APIRequestContext,
    options: TestFactoryOptions = {},
  ) {
    this.apiBaseUrl = options.apiBaseUrl ?? 'http://127.0.0.1:3101';
  }

  uniqueName(prefix: string): string {
    this.sequence += 1;
    return `${prefix} ${this.runId}-${this.sequence}`;
  }

  async reset(preset: TestSeedPreset = 'default'): Promise<TestResetResult> {
    return this.call<TestResetResult>('POST', '/__test__/reset', { preset });
  }

  async seed(preset: TestSeedPreset = 'default'): Promise<TestResetResult> {
    return this.reset(preset);
  }

  async setRuntimeMode(mode: RuntimeControlMode): Promise<{ mode: RuntimeControlMode }> {
    return this.call('POST', '/__test__/runtime/mode', { mode });
  }

  async advanceExecution(executionId: string, steps = 1): Promise<AdvanceExecutionResult> {
    return this.call('POST', `/__test__/executions/${executionId}/advance`, { steps });
  }

  async finishExecution(
    executionId: string,
    outcome: RuntimeFinishOutcome = 'success',
    reason?: string,
  ): Promise<FinishExecutionResult> {
    return this.call('POST', `/__test__/executions/${executionId}/finish`, {
      outcome,
      ...(reason ? { reason } : {}),
    });
  }

  async createAgent(
    overrides: Partial<CreateAgentInput> & { name?: string } = {},
  ): Promise<AgentDto> {
    const input: CreateAgentInput = {
      name: overrides.name ?? this.uniqueName('E2E Agent'),
      role: overrides.role ?? 'Automation Engineer',
      description:
        overrides.description ?? 'Created by the Raft Lite deterministic test-data factory.',
      runtime: overrides.runtime ?? 'mock',
      computerId: overrides.computerId ?? 'computer_local',
    };
    return this.call('POST', '/api/agents', input);
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<AgentDto> {
    return this.call('PATCH', `/api/agents/${id}`, input);
  }

  async getAgent(id: string): Promise<AgentDetailDto> {
    return this.call('GET', `/api/agents/${id}`);
  }

  async listAgents(): Promise<ListDto<AgentDto>> {
    return this.call('GET', '/api/agents?limit=100');
  }

  async deleteAgent(id: string): Promise<{ id: string }> {
    return this.call('DELETE', `/api/agents/${id}`);
  }

  async setAgentStatus(id: string, status: 'idle' | 'offline' | 'error'): Promise<AgentDto> {
    return this.updateAgent(id, { status });
  }

  async createTask(overrides: Partial<CreateTaskInput> = {}): Promise<TaskDto> {
    const input: CreateTaskInput = {
      title: overrides.title ?? this.uniqueName('E2E Task'),
      description:
        overrides.description ?? 'A deterministic task created through the public API.',
      projectId: overrides.projectId ?? 'project_demo',
      assigneeAgentId: overrides.assigneeAgentId ?? null,
      priority: overrides.priority ?? 'medium',
    };
    return this.call('POST', '/api/tasks', input);
  }

  async getTask(id: string): Promise<TaskDetailDto> {
    return this.call('GET', `/api/tasks/${id}`);
  }

  async listTasks(): Promise<ListDto<TaskDto>> {
    return this.call('GET', '/api/tasks?limit=200');
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<TaskDto> {
    return this.call('PATCH', `/api/tasks/${id}`, input);
  }

  async assignTask(id: string, agentId: string | null): Promise<TaskDto> {
    return this.call('POST', `/api/tasks/${id}/assign`, { agentId });
  }

  async deleteTask(id: string): Promise<{ id: string }> {
    return this.call('DELETE', `/api/tasks/${id}`);
  }

  async startTask(taskId: string): Promise<ExecutionDto> {
    return this.call('POST', `/api/tasks/${taskId}/start`, {});
  }

  async cancelTask(taskId: string, reason?: string): Promise<TaskCancellationDto> {
    return this.call('POST', `/api/tasks/${taskId}/cancel`, reason ? { reason } : {});
  }

  async getRuntimes(
    params: { computerId?: string; projectId?: string } = {},
  ): Promise<{ items: RuntimeAvailabilityDto[] }> {
    const search = new URLSearchParams();
    if (params.computerId) search.set('computerId', params.computerId);
    if (params.projectId) search.set('projectId', params.projectId);
    const query = search.toString();
    return this.call('GET', `/api/runtimes${query ? `?${query}` : ''}`);
  }

  async getExecution(id: string): Promise<ExecutionDto> {
    return this.call('GET', `/api/executions/${id}`);
  }

  async getExecutionLogs(id: string): Promise<ListDto<ExecutionLogDto>> {
    return this.call('GET', `/api/executions/${id}/logs?limit=500`);
  }

  async getExecutionDiff(id: string): Promise<ExecutionDiffDto> {
    return this.call('GET', `/api/executions/${id}/diff`);
  }

  /**
   * Creates an idle mock agent, a task assigned to it, and starts the execution.
   * The runtime must be in manual mode when a test needs to control stepping.
   */
  async createRunningExecution(
    options: {
      agent?: Partial<CreateAgentInput>;
      task?: Partial<CreateTaskInput>;
    } = {},
  ): Promise<{ agent: AgentDto; task: TaskDto; execution: ExecutionDto }> {
    const agent = await this.createAgent(options.agent);
    const task = await this.createTask({
      ...options.task,
      assigneeAgentId: agent.id,
    });
    const execution = await this.startTask(task.id);
    return { agent, task, execution };
  }

  private async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const response = await this.request.fetch(`${this.apiBaseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { data: body }),
    });
    const payload = await this.parse(response);
    if (!response.ok()) {
      const error = payload as ApiErrorBody | undefined;
      const message = error?.error?.message ?? `HTTP ${response.status()} for ${method} ${path}`;
      throw new Error(`${error?.error?.code ?? 'E2E_FACTORY_ERROR'}: ${message}`);
    }
    return (payload as ApiSuccess<T>).data;
  }

  private async parse(response: APIResponse): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
