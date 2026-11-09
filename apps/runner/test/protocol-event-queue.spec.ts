import { describe, expect, it } from 'vitest';
import { ProtocolEventQueue } from '../src/protocol-event-queue';

describe('ProtocolEventQueue', () => {
  it('waits for a durable append before sending and before a terminal event', async () => {
    const queue = new ProtocolEventQueue();
    const order: string[] = [];

    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });

    queue.enqueue('execution_a', async () => {
      order.push('append-start');
      appendStarted();
      await appendGate;
      order.push('append-done');
      order.push('send-log');
    });
    queue.enqueue('execution_a', () => {
      order.push('send-terminal');
    });

    await started;
    expect(order).toEqual(['append-start']);

    releaseAppend();
    await queue.drain();
    expect(order).toEqual(['append-start', 'append-done', 'send-log', 'send-terminal']);
  });

  it('does not let one execution block another execution', async () => {
    const queue = new ProtocolEventQueue();
    const order: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    queue.enqueue('execution_slow', async () => {
      await slowGate;
      order.push('slow');
    });
    let fastDone!: () => void;
    const fast = new Promise<void>((resolve) => {
      fastDone = resolve;
    });
    queue.enqueue('execution_fast', () => {
      order.push('fast');
      fastDone();
    });

    await fast;
    expect(order).toEqual(['fast']);

    releaseSlow();
    await queue.drain();
    expect(order).toEqual(['fast', 'slow']);
  });

  it('keeps later events usable after a failed event and drains cleanly', async () => {
    const queue = new ProtocolEventQueue();
    const order: string[] = [];

    queue.enqueue('execution_failure', () => {
      order.push('failed');
      throw new Error('append failed');
    });
    queue.enqueue('execution_failure', () => {
      order.push('after-failure');
    });

    await expect(queue.drain()).resolves.toBeUndefined();
    expect(order).toEqual(['failed', 'after-failure']);
  });
});
