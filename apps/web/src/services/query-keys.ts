import type {
  AgentListQuery,
  RunnerRuntimeAvailabilityQuery,
  TaskListQuery,
} from '@raft-lite/contracts';

export const queryKeys = {
  dashboard: ['dashboard'] as const,
  workspace: ['workspace'] as const,
  computers: ['computers'] as const,
  runtimes: (params: RunnerRuntimeAvailabilityQuery) => ['runtimes', params] as const,
  activities: (limit = 30) => ['activities', limit] as const,
  agents: {
    all: ['agents'] as const,
    list: (filters: AgentListQuery) => ['agents', 'list', filters] as const,
    detail: (id: string) => ['agents', 'detail', id] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    list: (filters: TaskListQuery) => ['tasks', 'list', filters] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
  },
  executions: {
    all: ['executions'] as const,
    detail: (id: string) => ['executions', 'detail', id] as const,
    logs: (id: string) => ['executions', 'logs', id] as const,
  },
};
