import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import type { ExecutionDto, ExecutionLogDto, ListDto } from '@raft-lite/contracts';
import { queryKeys } from '../services/query-keys';

export type SocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const SocketStatusContext = createContext<SocketStatus>('connecting');

const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? '';

interface ExecutionUpdatedPayload extends ExecutionDto {
  id: string;
  status: ExecutionDto['status'];
}

export function SocketProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const hasConnected = useRef(false);

  useEffect(() => {
    const socket: Socket = io(`${SOCKET_URL || window.location.origin}/events`, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelayMax: 4000,
    });

    const invalidateWorkspaceData = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    };

    socket.on('connect', () => {
      setStatus('connected');
      if (hasConnected.current) {
        void queryClient.invalidateQueries();
      }
      hasConnected.current = true;
    });

    socket.io.on('reconnect_attempt', () => {
      setStatus('reconnecting');
    });

    socket.on('disconnect', () => {
      setStatus('disconnected');
    });

    socket.on('connect_error', () => {
      setStatus((current) => (current === 'connected' ? 'reconnecting' : 'disconnected'));
    });

    socket.on('task.updated', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    });

    socket.on('task.removed', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    });

    socket.on('agent.updated', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    });

    socket.on('agent.removed', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.executions.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    });

    socket.on('execution.updated', (execution: ExecutionUpdatedPayload) => {
      // Progress events arrive frequently. The payload is a complete ExecutionDto,
      // so update the detail cache directly and only invalidate dependent queries
      // when the execution reaches a terminal state.
      queryClient.setQueryData(queryKeys.executions.detail(execution.id), execution);
      if (execution.status !== 'running') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.executions.all });
        void queryClient.invalidateQueries({ queryKey: queryKeys.executions.logs(execution.id) });
        invalidateWorkspaceData();
      }
    });

    socket.on('execution.log', (log: ExecutionLogDto) => {
      const key = queryKeys.executions.logs(log.executionId);
      queryClient.setQueryData<ListDto<ExecutionLogDto>>(key, (current) => {
        if (!current) return current;
        if (current.items.some((item) => item.seq === log.seq)) return current;
        return {
          items: [...current.items, log].sort((a, b) => a.seq - b.seq),
          total: Math.max(current.total, log.seq),
        };
      });
    });

    socket.on('activity.created', () => {
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [queryClient]);

  const value = useMemo(() => status, [status]);
  return <SocketStatusContext.Provider value={value}>{children}</SocketStatusContext.Provider>;
}

export function useSocketStatus(): SocketStatus {
  return useContext(SocketStatusContext);
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const onOnline = (): void => setOnline(true);
    const onOffline = (): void => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}
