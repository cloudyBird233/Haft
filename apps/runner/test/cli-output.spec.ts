import { describe, expect, it } from 'vitest';
import { createCliOutputParser } from '../src/cli-output';

function jsonLines(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

describe('Codex output parser', () => {
  it('turns JSONL events into bounded logs and keeps the final agent message', () => {
    const parser = createCliOutputParser('codex');
    const lines = parser.push(
      jsonLines(
        { type: 'thread.started', thread_id: 'thread_1' },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: { id: 'item_0', type: 'agent_message', text: 'Implemented the change.' },
        },
        {
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: 'Tests passed\n',
            exit_code: 0,
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'item_2',
            type: 'file_change',
            changes: [{ path: 'src/feature.ts', kind: 'update' }],
          },
        },
        { type: 'turn.completed', usage: { input_tokens: 10 } },
      ),
      'stdout',
    );

    expect(lines.map((line) => line.message)).toEqual(
      expect.arrayContaining([
        'Codex thread started.',
        'Codex turn started.',
        'Implemented the change.',
        'Tests passed',
        'File change: src/feature.ts (update)',
        'Codex turn completed.',
      ]),
    );
    expect(parser.lastSummary()).toBe('Implemented the change.');
    expect(parser.lastError()).toBeNull();
  });

  it('marks failing commands and turn failures as errors', () => {
    const parser = createCliOutputParser('codex');
    const lines = parser.push(
      jsonLines(
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: '1 test failed\n',
            exit_code: 1,
          },
        },
        { type: 'turn.failed', error: { message: 'model failed' } },
      ),
      'stdout',
    );
    expect(lines.some((line) => line.level === 'error' && line.message.includes('code 1'))).toBe(
      true,
    );
    expect(lines.some((line) => line.message.includes('model failed'))).toBe(true);
    expect(parser.lastError()).toContain('model failed');
  });

  it('preserves non-JSON stderr diagnostics and redacts credentials', () => {
    const parser = createCliOutputParser('codex');
    const lines = parser.push(
      'warning: retrying with api_key=super-secret-value\nBearer abcdefghijklmnop\n',
      'stderr',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.stream).toBe('stderr');
    expect(lines[0]?.level).toBe('warning');
    expect(lines[0]?.message).not.toContain('super-secret-value');
    expect(lines[1]?.message).not.toContain('abcdefghijklmnop');
  });

  it('handles chunk boundaries and an unterminated final line', () => {
    const parser = createCliOutputParser('codex');
    const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'split message' } });
    const first = parser.push(event.slice(0, 20), 'stdout');
    const second = parser.push(`${event.slice(20)}\n`, 'stdout');
    expect(first).toHaveLength(0);
    expect(second.some((line) => line.message === 'split message')).toBe(true);
  });
});

describe('OpenCode output parser', () => {
  it('extracts text, tools and step completion from JSON events', () => {
    const parser = createCliOutputParser('opencode');
    const lines = parser.push(
      jsonLines(
        { type: 'step_start', part: { type: 'step-start' } },
        { type: 'text', part: { type: 'text', text: 'OK' } },
        {
          type: 'tool',
          part: {
            type: 'tool',
            tool: 'bash',
            state: { status: 'completed', title: 'Run tests' },
          },
        },
        { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
      ),
      'stdout',
    );
    expect(lines.map((line) => line.message)).toEqual([
      'OK',
      'Tool bash (completed): Run tests',
      'OpenCode step finished: stop.',
    ]);
    expect(parser.lastSummary()).toBe('OK');
  });

  it('propagates provider errors with their message', () => {
    const parser = createCliOutputParser('opencode');
    const lines = parser.push(
      jsonLines({
        type: 'error',
        error: { type: 'provider.auth', message: 'This model is not available' },
      }),
      'stdout',
    );
    expect(lines[0]).toMatchObject({ stream: 'stderr', level: 'error' });
    expect(lines[0]?.message).toContain('This model is not available');
    expect(parser.lastError()).toBe('This model is not available');
  });
});
