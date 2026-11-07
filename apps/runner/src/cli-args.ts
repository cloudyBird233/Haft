import type { ExecutionStartMessage, RunnerRuntimeType } from '@raft-lite/contracts';
import type { RunnerConfig } from './config';

/**
 * Argument builders are pure and tested: no shell, no prompt in argv, no
 * implicit auto-approval. Codex and OpenCode both read the task prompt from
 * stdin, which keeps task text out of process listings and command lines.
 */

export type CliArgConfig = Pick<RunnerConfig, 'allowAutoApprove' | 'cliModels'>;

export function buildCliArgs(
  runtime: RunnerRuntimeType,
  payload: ExecutionStartMessage['payload'],
  worktreePath: string,
  config: CliArgConfig,
): string[] {
  if (runtime === 'codex') {
    return buildCodexArgs(payload, worktreePath, config);
  }
  return buildOpencodeArgs(payload, config);
}

export function buildCodexArgs(
  payload: ExecutionStartMessage['payload'],
  worktreePath: string,
  config: CliArgConfig,
): string[] {
  const args = ['exec', '--json', '--color', 'never', '--ephemeral'];
  const requestedSandbox = payload.options.sandbox;
  const sandbox =
    requestedSandbox === 'read-only' || requestedSandbox === 'workspace-write'
      ? requestedSandbox
      : 'workspace-write';

  // Codex always stays inside its workspace-write sandbox. Unlike OpenCode,
  // there is deliberately no bypass flag: the Git worktree is isolation for
  // review, not an OS security boundary.
  args.push('--sandbox', sandbox);

  args.push('-C', worktreePath);

  const model = payload.options.model?.trim() || config.cliModels.codex?.trim();
  if (model) {
    args.push('-m', model);
  }

  // "-" tells codex exec to read the prompt from stdin.
  args.push('-');
  return args;
}

export function buildOpencodeArgs(
  payload: ExecutionStartMessage['payload'],
  config: CliArgConfig,
): string[] {
  const args = ['run', '--standalone', '--format', 'json'];

  let model = payload.options.model?.trim() || config.cliModels.opencode?.trim() || '';
  const variant = payload.options.variant?.trim();
  if (model && variant && !model.includes('#')) {
    model = `${model}#${variant}`;
  }
  if (model) {
    args.push('-m', model);
  }

  const agent = payload.options.agent?.trim();
  if (agent) {
    args.push('--agent', agent);
  }

  if (config.allowAutoApprove) {
    args.push('--auto');
  }

  // No message argument: opencode reads the prompt from stdin when the
  // message list is empty.
  return args;
}
