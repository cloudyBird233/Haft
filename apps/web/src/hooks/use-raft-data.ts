import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AgentListQuery, TaskListQuery } from '@raft-lite/contracts';
import { api } from '../services/api';
import { queryKeys } from '../services/query-keys';

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: api.getDashboard,
  });
}

export function useComputers() {
  return useQuery({
    queryKey: queryKeys.computers,
    queryFn: api.getComputers,
    staleTime: 60_000,
  });
}

export function useWorkspace() {
  return useQuery({
    queryKey: queryKeys.workspace,
    queryFn: api.getWorkspace,
    staleTime: 60_000,
  });
}

export function useAgents(filters: AgentListQuery = {}) {
  return useQuery({
    queryKey: queryKeys.agents.list(filters),
    queryFn: () => api.listAgents(filters),
    placeholderData: keepPreviousData,
  });
}

export function useAgent(id: string | null) {
  return useQuery({
    queryKey: queryKeys.agents.detail(id ?? 'none'),
    queryFn: () => api.getAgent(id as string),
    enabled: Boolean(id),
  });
}

export function useTasks(filters: TaskListQuery = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.list(filters),
    queryFn: () => api.listTasks(filters),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id ?? 'none'),
    queryFn: () => api.getTask(id as string),
    enabled: Boolean(id),
  });
}

export function useExecution(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.executions.detail(id ?? 'none'),
    queryFn: () => api.getExecution(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 1500 : false,
  });
}

export function useExecutionLogs(id: string | undefined, live: boolean) {
  return useQuery({
    queryKey: queryKeys.executions.logs(id ?? 'none'),
    queryFn: () => api.getExecutionLogs(id as string),
    enabled: Boolean(id),
    refetchInterval: live ? 1500 : false,
  });
}

export function useActivities(limit = 30) {
  return useQuery({
    queryKey: queryKeys.activities(limit),
    queryFn: () => api.listActivities(limit),
  });
}
