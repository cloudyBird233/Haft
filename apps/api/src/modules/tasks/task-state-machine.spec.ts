import { describe, expect, it } from 'vitest';
import { canTransitionTask } from '@raft-lite/contracts';

describe('execution transition invariants', () => {
  it('allows manual completion only from active review states', () => {
    expect(canTransitionTask('in_progress', 'done')).toBe(true);
    expect(canTransitionTask('in_review', 'done')).toBe(true);
    expect(canTransitionTask('todo', 'done')).toBe(false);
  });

  it('supports recovery from failed and cancelled tasks', () => {
    expect(canTransitionTask('failed', 'todo')).toBe(true);
    expect(canTransitionTask('cancelled', 'todo')).toBe(true);
  });
});
