import { log } from './logger';

/**
 * Serializes protocol events per execution.
 *
 * The executor callback interface is synchronous, but a log event awaits its
 * durable spool append inside the queue. A later terminal event therefore
 * cannot overtake an earlier append/send, and a crash between append and send
 * still leaves the spool entry replayable.
 */
export class ProtocolEventQueue {
  private readonly events = new Map<string, Promise<void>>();

  enqueue(executionId: string, task: () => void | Promise<void>): void {
    const previous = this.events.get(executionId) ?? Promise.resolve();
    const next = previous
      .then(task, task)
      .catch((error: unknown) => {
        log('warn', {
          eventType: 'runner.event_failed',
          message: 'Could not deliver a runner protocol event',
          status: 'warning',
          executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.events.get(executionId) === next) {
          this.events.delete(executionId);
        }
      });
    this.events.set(executionId, next);
  }

  /** Waits until every queued event, including failures, has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.events.values()]);
  }
}
