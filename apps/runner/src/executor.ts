import type {
  ExecutionPhase,
  ExecutionStartMessage,
  GitExecutionResult,
  ProgressMode,
  RunnerLogEntry,
  RunnerRuntimeType,
} from '@raft-lite/contracts';

/**
 * Minimal session view shared by the deterministic Fake Runner and the real
 * CLI executor. Callbacks never expose process handles to the protocol layer.
 */
export interface RunnerSessionView {
  executionId: string;
  runtime: RunnerRuntimeType;
  phase: ExecutionPhase;
  lastSeq: number;
  startedAt: string;
}

export interface ExecutorCallbacks {
  onPhase(session: RunnerSessionView, phase: ExecutionPhase, message?: string | null): void;
  onLog(session: RunnerSessionView, entry: RunnerLogEntry): void;
  onProgress(
    session: RunnerSessionView,
    progress: number,
    step: number,
    progressMode?: ProgressMode,
  ): void;
  onCompleted(session: RunnerSessionView, payload: CompletedPayload): void;
  onFailed(session: RunnerSessionView, payload: FailedPayload): void;
  onCancelled(session: RunnerSessionView, payload: CancelledPayload): void;
}

export interface CompletedPayload {
  exitCode: number | null;
  summary: string | null;
  git: GitExecutionResult | null;
}

export interface FailedPayload {
  reason: string;
  exitCode: number | null;
  summary: string | null;
  git: GitExecutionResult | null;
}

export interface CancelledPayload {
  reason: string | null;
  exitCode: number | null;
  git: GitExecutionResult | null;
}

export interface RunnerExecutor {
  start(payload: ExecutionStartMessage['payload']): void;
  cancel(executionId: string, reason?: string): void;
  acknowledge(executionId: string, throughSeq: number): void;
  pendingLogs(executionId: string): RunnerLogEntry[];
  pendingLogCount(): number;
  snapshot(): Array<{
    executionId: string;
    phase: ExecutionPhase;
    lastSeq: number;
    startedAt: string;
    runtime: RunnerRuntimeType;
  }>;
  activeExecutionIds(): string[];
  shutdown(reason?: string): void;
}
