import { beforeEach, describe, expect, it } from 'vitest';
import { MockRuntimeService } from '../src/modules/runtime/mock-runtime.service';
import type { RuntimeEvent } from '../src/modules/runtime/agent-runtime.interface';
import { AppLogger } from '../src/common/logger/app-logger';

const context = {
  executionId: 'execution_test',
  taskId: 'task_test',
  taskTitle: 'Test the mock runtime',
  agentId: 'agent_test',
  agentName: 'Tester',
};

describe('MockRuntimeService', () => {
  let runtime: MockRuntimeService;
  let events: RuntimeEvent[];

  beforeEach(() => {
    runtime = new MockRuntimeService(new AppLogger());
    runtime.onEvent((event) => events.push(event));
    events = [];
    runtime.setMode('manual');
  });

  it('starts in a running state and emits an immediate log', async () => {
    await runtime.start(context);
    const status = await runtime.getStatus(context.executionId);
    expect(status).toMatchObject({ status: 'running', progress: 0, step: 0 });
    expect(events[0]).toMatchObject({ type: 'log', seq: 1 });
  });

  it('advances deterministically with progress and logs', async () => {
    await runtime.start(context);
    const result = runtime.advance(context.executionId, 2);
    expect(result).toMatchObject({ step: 2, progress: 40, completed: false });
    expect(events.some((event) => event.type === 'progress' && event.progress === 40)).toBe(true);
    expect(events.filter((event) => event.type === 'log')).toHaveLength(3);
  });

  it('completes at the end of the deterministic step sequence', async () => {
    await runtime.start(context);
    runtime.advance(context.executionId, 20);
    expect(events.some((event) => event.type === 'completed')).toBe(true);
    expect(await runtime.getStatus(context.executionId)).toBeNull();
  });

  it('can emit a failure outcome with a concrete reason', async () => {
    await runtime.start(context);
    const emitted = runtime.finish(context.executionId, 'failure', 'Unit test failure');
    expect(emitted).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'failed', reason: 'Unit test failure' }),
        expect.objectContaining({ type: 'log', level: 'error' }),
      ]),
    );
    expect(await runtime.getStatus(context.executionId)).toBeNull();
  });

  it('stops without emitting completion and releases the session', async () => {
    await runtime.start(context);
    await runtime.stop(context.executionId);
    expect(await runtime.getStatus(context.executionId)).toBeNull();
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  });
});
