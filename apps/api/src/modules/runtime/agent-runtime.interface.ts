import type { ExecutionStatus, LogLevel } from '@raft-lite/contracts';

export interface RuntimeContext {
  executionId: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
}

export type RuntimeEvent =
  | {
      type: 'log';
      executionId: string;
      level: LogLevel;
      message: string;
      seq: number;
    }
  | {
      type: 'progress';
      executionId: string;
      progress: number;
      step: number;
    }
  | {
      type: 'completed';
      executionId: string;
    }
  | {
      type: 'failed';
      executionId: string;
      reason: string;
    };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeStatus {
  executionId: string;
  status: ExecutionStatus;
  progress: number;
  step: number;
}

/**
 * Stable seam for real CLI integrations.
 * Implementations must not expose arbitrary HTTP-triggered shell execution.
 */
export interface AgentRuntime {
  readonly type: string;
  start(context: RuntimeContext): Promise<void>;
  stop(executionId: string): Promise<void>;
  getStatus(executionId: string): Promise<RuntimeStatus | null>;
  onEvent(listener: RuntimeEventListener): () => void;
}

export const AGENT_RUNTIME = Symbol('AGENT_RUNTIME');
