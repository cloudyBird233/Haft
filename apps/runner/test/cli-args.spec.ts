import { describe, expect, it } from 'vitest';
import type { ExecutionStartMessage } from '@raft-lite/contracts';
import { buildCliArgs, buildCodexArgs, buildOpencodeArgs } from '../src/cli-args';
import type { CliArgConfig } from '../src/cli-args';

const config: CliArgConfig = {
  allowAutoApprove: false,
  cliModels: { codex: 'configured-codex', opencode: 'configured/opencode' },
};

function payload(
  overrides: Partial<ExecutionStartMessage['payload']> = {},
): ExecutionStartMessage['payload'] {
  return {
    executionId: 'execution_args',
    runtime: 'codex',
    taskId: 'task_args',
    taskTitle: 'Argument safety',
    taskDescription: 'Never put task text on the command line.',
    projectId: 'project_demo',
    prompt: 'Create a file; rm -rf / && echo "not executed"',
    options: {},
    ...overrides,
  };
}

describe('CLI argument builders', () => {
  it('keeps the prompt off the Codex command line and does not auto-approve', () => {
    const args = buildCodexArgs(payload(), 'C:/worktrees/execution_args', config);
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('-C');
    expect(args).toContain('C:/worktrees/execution_args');
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.join(' ')).not.toContain('rm -rf');
    expect(args).not.toContain(payload().prompt);
  });

  it('never bypasses the Codex sandbox, even when auto approval is configured', () => {
    const args = buildCodexArgs(payload(), 'C:/worktrees/execution_args', {
      ...config,
      allowAutoApprove: true,
    });
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
  });

  it('prefers execution options over configured models and honors read-only sandbox', () => {
    const args = buildCodexArgs(
      payload({
        options: { model: 'task-model', sandbox: 'read-only' },
      }),
      'C:/worktrees/execution_args',
      config,
    );
    expect(args).toContain('-m');
    expect(args).toContain('task-model');
    expect(args).not.toContain('configured-codex');
    expect(args).toContain('read-only');
  });

  it('builds OpenCode arguments with stdin delivery and no implicit --auto', () => {
    const args = buildOpencodeArgs(
      payload({
        runtime: 'opencode',
        options: { model: 'task/opencode', agent: 'build', variant: 'fast' },
      }),
      config,
    );
    expect(args.slice(0, 4)).toEqual(['run', '--standalone', '--format', 'json']);
    expect(args).toContain('-m');
    expect(args).toContain('task/opencode#fast');
    expect(args).toContain('--agent');
    expect(args).toContain('build');
    expect(args).not.toContain('--auto');
    expect(args).not.toContain(payload().prompt);
  });

  it('adds OpenCode --auto only when explicitly configured', () => {
    const args = buildOpencodeArgs(payload({ runtime: 'opencode' }), {
      ...config,
      allowAutoApprove: true,
    });
    expect(args).toContain('--auto');
  });

  it('dispatches to the runtime-specific builder', () => {
    expect(buildCliArgs('codex', payload(), 'C:/wt', config).at(-1)).toBe('-');
    expect(
      buildCliArgs('opencode', payload({ runtime: 'opencode' }), 'C:/wt', config)[0],
    ).toBe('run');
  });
});
