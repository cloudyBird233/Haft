import type {
  ExecutionPhase,
  ExecutionStatus,
  LogLevel,
  LogStream,
  ProgressMode,
} from '@raft-lite/contracts';

export interface RuntimeContext {
  executionId: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  projectId?: string;
  agentId: string;
  agentName: string;
  runnerId?: string | null;
  options?: {
    model?: string | null;
    agent?: string | null;
    variant?: string | null;
    sandbox?: string | null;
    timeoutMs?: number;
  };
}

export interface RuntimeGitResult {
  branchName: string;
  baseCommit: string;
  headCommit: string | null;
  changedFiles: number;
  diffStat: string;
  gitStatus: string;
}

export type RuntimeEvent =
  | {
      type: 'log';
      executionId: string;
      level: LogLevel;
      message: string;
      seq: number;
      stream?: LogStream;
      eventId?: string;
      runnerSeq?: number;
      timestamp?: string;
    }
  | {
      type: 'phase';
      executionId: string;
      phase: ExecutionPhase;
      message?: string | null;
    }
  | {
      type: 'progress';
      executionId: string;
      progress: number;
      step?: number;
      progressMode?: ProgressMode;
    }
  | {
      type: 'completed';
      executionId: string;
      exitCode?: number | null;
      summary?: string | null;
      git?: RuntimeGitResult | null;
    }
  | {
      type: 'failed';
      executionId: string;
      reason: string;
      exitCode?: number | null;
      summary?: string | null;
      git?: RuntimeGitResult | null;
    }
  | {
      type: 'cancelled';
      executionId: string;
      reason?: string | null;
      exitCode?: number | null;
      git?: RuntimeGitResult | null;
    };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeStatus {
  executionId: string;
  status: ExecutionStatus;
  phase?: ExecutionPhase;
  progress: number;
  progressMode?: ProgressMode;
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

/** Retained for compatibility with earlier direct-injection wiring. */
export const AGENT_RUNTIME = Symbol('AGENT_RUNTIME');
