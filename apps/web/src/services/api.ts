import type {
  ActivityDto,
  ApiErrorBody,
  ApiErrorDetail,
  ApiSuccess,
  AssignTaskInput,
  CancelExecutionInput,
  ComputerDto,
  CreateAgentInput,
  CreateTaskInput,
  DashboardDto,
  ExecutionDto,
  ExecutionDiffDto,
  ExecutionListQuery,
  ExecutionLogDto,
  HealthDto,
  ListDto,
  TaskCancellationDto,
  TaskDetailDto,
  TaskDto,
  TaskListQuery,
  UpdateAgentInput,
  UpdateTaskInput,
  WorkspaceDto,
  AgentDetailDto,
  AgentDto,
  AgentListQuery,
  RunnerRuntimeAvailabilityQuery,
  RuntimeAvailabilityDto,
} from '@raft-lite/contracts';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: ApiErrorDetail[] | Record<string, unknown> | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    options: {
      code?: string;
      status?: number;
      details?: ApiErrorDetail[] | Record<string, unknown> | null;
      requestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? 'UNKNOWN_ERROR';
    this.status = options.status ?? 0;
    this.details = options.details ?? null;
    this.requestId = options.requestId ?? null;
  }
}

type QueryValue = string | number | boolean | null | undefined;

function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const result = search.toString();
  return result ? `?${result}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('Cannot reach the Raft Lite API. Check that the server is running.', {
      code: 'NETWORK_ERROR',
    });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorBody = payload as Partial<ApiErrorBody> | null;
    throw new ApiError(errorBody?.error?.message ?? `Request failed with status ${response.status}`, {
      code: errorBody?.error?.code ?? `HTTP_${response.status}`,
      status: response.status,
      details: errorBody?.error?.details ?? null,
      requestId: errorBody?.requestId ?? response.headers.get('x-request-id'),
    });
  }

  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as ApiSuccess<T>).data;
  }
  throw new ApiError('The API returned an unexpected response shape.', {
    code: 'INVALID_RESPONSE',
    status: response.status,
  });
}

const json = (value: unknown): string => JSON.stringify(value);

export const api = {
  health: () => request<HealthDto>('/health'),

  getWorkspace: () => request<WorkspaceDto>('/workspace'),
  getDashboard: () => request<DashboardDto>('/dashboard'),
  getComputers: () => request<ListDto<ComputerDto>>('/computers'),
  listRuntimes: (params: RunnerRuntimeAvailabilityQuery = {}) =>
    request<{ items: RuntimeAvailabilityDto[] }>(
      `/runtimes${queryString({
        computerId: params.computerId,
        projectId: params.projectId,
      })}`,
    ),

  listAgents: (params: AgentListQuery = {}) =>
    request<ListDto<AgentDto>>(
      `/agents${queryString({
        search: params.search,
        status: params.status,
        limit: params.limit ?? 100,
        offset: params.offset,
      })}`,
    ),
  getAgent: (id: string) =>
    request<AgentDetailDto>(`/agents/${encodeURIComponent(id)}`),
  createAgent: (input: CreateAgentInput) =>
    request<AgentDto>('/agents', { method: 'POST', body: json(input) }),
  updateAgent: (id: string, input: UpdateAgentInput) =>
    request<AgentDto>(`/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: json(input),
    }),
  deleteAgent: (id: string) =>
    request<{ id: string }>(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listTasks: (params: TaskListQuery = {}) =>
    request<ListDto<TaskDto>>(
      `/tasks${queryString({
        search: params.search,
        status: params.status,
        priority: params.priority,
        projectId: params.projectId,
        assigneeAgentId: params.assigneeAgentId,
        limit: params.limit ?? 200,
        offset: params.offset,
      })}`,
    ),
  getTask: (id: string) => request<TaskDetailDto>(`/tasks/${encodeURIComponent(id)}`),
  createTask: (input: CreateTaskInput) =>
    request<TaskDto>('/tasks', { method: 'POST', body: json(input) }),
  updateTask: (id: string, input: UpdateTaskInput) =>
    request<TaskDto>(`/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: json(input),
    }),
  deleteTask: (id: string) =>
    request<{ id: string }>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assignTask: (id: string, input: AssignTaskInput) =>
    request<TaskDto>(`/tasks/${encodeURIComponent(id)}/assign`, {
      method: 'POST',
      body: json(input),
    }),
  startTask: (id: string) =>
    request<ExecutionDto>(`/tasks/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  cancelTask: (id: string, input?: CancelExecutionInput) =>
    request<TaskCancellationDto>(`/tasks/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: json(input ?? {}),
    }),

  listExecutions: (params: ExecutionListQuery = {}) =>
    request<ListDto<ExecutionDto>>(
      `/executions${queryString({
        taskId: params.taskId,
        agentId: params.agentId,
        status: params.status,
        limit: params.limit,
        offset: params.offset,
      })}`,
    ),
  getExecution: (id: string) =>
    request<ExecutionDto>(`/executions/${encodeURIComponent(id)}`),
  getExecutionLogs: (id: string) =>
    request<ListDto<ExecutionLogDto>>(
      `/executions/${encodeURIComponent(id)}/logs${queryString({ limit: 500 })}`,
    ),
  getExecutionDiff: (id: string) =>
    request<ExecutionDiffDto>(`/executions/${encodeURIComponent(id)}/diff`),
  cancelExecution: (id: string, input?: CancelExecutionInput) =>
    request<ExecutionDto>(`/executions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: json(input ?? {}),
    }),

  listActivities: (limit = 30) =>
    request<ListDto<ActivityDto>>(`/activities${queryString({ limit })}`),
};
