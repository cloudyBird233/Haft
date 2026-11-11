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
