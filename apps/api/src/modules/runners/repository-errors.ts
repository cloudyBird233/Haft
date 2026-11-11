import type { ErrorCode } from '@raft-lite/contracts';

/**
 * A synchronous pre-start handshake failure.
 *
 * `RepositoryHandshakeService` throws this instead of writing terminal state:
 * `ExecutionsService.failExecutionStart` remains the single writer so the
 * task/agent rollback is applied exactly once.
 */
export class RepositoryDispatchError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RepositoryDispatchError';
  }
}

/**
 * The operator cancelled the execution while its handshake was still
 * in flight. This is not a failure: the cancellation path owns the terminal
 * state, so `ExecutionsService` must never route it through
 * `failExecutionStart` (which would restore Task/Agent as a failed start).
 */
export class RepositoryDispatchCancelledError extends Error {
  constructor(message = 'The execution was cancelled before it started') {
    super(message);
    this.name = 'RepositoryDispatchCancelledError';
  }
}
