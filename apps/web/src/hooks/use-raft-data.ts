import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AgentListQuery,
  RunnerRuntimeAvailabilityQuery,
  TaskListQuery,
} from '@raft-lite/contracts';
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

export function useRuntimes(params: RunnerRuntimeAvailabilityQuery = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.runtimes(params),
    queryFn: () => api.listRuntimes(params),
    enabled,
    staleTime: 5_000,
  });
}

export function useWorkspace() {
  return useQuery({
    queryKey: queryKeys.workspace,
    queryFn: api.getWorkspace,
    staleTime: 60_000,
  });
}

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: queryKeys.projects.list(),
    queryFn: api.listProjects,
    enabled,
    staleTime: 15_000,
  });
}

export function useProject(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.projects.detail(id ?? 'none'),
    queryFn: () => api.getProject(id as string),
    enabled: Boolean(id) && enabled,
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
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
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

/**
 * On-demand Git diff. It is only requested when the Changes tab is opened, so
 * execution lists and the default log view never download large patches.
 */
export function useExecutionDiff(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.executions.diff(id ?? 'none'),
    queryFn: () => api.getExecutionDiff(id as string),
    enabled: Boolean(id) && enabled,
    staleTime: 30_000,
  });
}

export function useActivities(limit = 30) {
  return useQuery({
    queryKey: queryKeys.activities(limit),
    queryFn: () => api.listActivities(limit),
  });
}
