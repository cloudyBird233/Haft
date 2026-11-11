import type {
  ErrorCode,
  ExecutionPhase,
  ExecutionStartMessage,
  GitExecutionResult,
  ProgressMode,
  RunnerLogEntry,
  RunnerRuntimeType,
} from '@raft-lite/contracts';
import type { RepositoryContext } from './repository-context';

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

export interface ShutdownResult {
  /** True only when every session reached a terminal state and its process exited. */
  clean: boolean;
  /** Sessions that were still active after the shutdown grace window. */
  remainingExecutionIds: string[];
  /** True when the runner had to escalate from graceful cancellation to a tree kill. */
  forced: boolean;
}

export type ExecutorAdmission =
  { ok: true } | { ok: false; code: ErrorCode; message: string; retryable: boolean };

export interface RunnerExecutor {
  /**
   * Synchronous admission check performed before `execution.accepted`.
   * It must not spawn a CLI and must cover runtime enablement, capacity and
   * duplicate execution ids.
   */
  canAdmit(
    payload: ExecutionStartMessage['payload'],
    context: RepositoryContext,
  ): ExecutorAdmission;
  start(payload: ExecutionStartMessage['payload'], context: RepositoryContext): void;
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
  shutdown(reason?: string): Promise<ShutdownResult>;
}
