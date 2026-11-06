import { describe, expect, it } from 'vitest';
import {
  TASK_STATUS_TRANSITIONS,
  canTransitionTask,
  createTaskSchema,
  isTerminalTaskStatus,
} from '../src';

describe('task state machine', () => {
  it('allows the canonical happy path', () => {
    expect(canTransitionTask('todo', 'claimed')).toBe(true);
    expect(canTransitionTask('claimed', 'in_progress')).toBe(true);
    expect(canTransitionTask('in_progress', 'in_review')).toBe(true);
    expect(canTransitionTask('in_review', 'done')).toBe(true);
  });

  it('rejects invalid jumps', () => {
    expect(canTransitionTask('todo', 'done')).toBe(false);
    expect(canTransitionTask('done', 'in_progress')).toBe(false);
  });

  it('treats done as terminal', () => {
    expect(isTerminalTaskStatus('done')).toBe(true);
    expect(TASK_STATUS_TRANSITIONS.done).toHaveLength(0);
  });
});

describe('task input schema', () => {
  it('applies safe defaults', () => {
    const parsed = createTaskSchema.parse({ title: 'Ship the demo', projectId: 'project-demo' });
    expect(parsed.priority).toBe('medium');
    expect(parsed.description).toBe('');
    expect(parsed.assigneeAgentId).toBeNull();
  });

  it('rejects an empty title', () => {
    expect(createTaskSchema.safeParse({ title: ' ', projectId: 'project-demo' }).success).toBe(false);
  });
});
