import type { RunnerRuntimeType } from '@raft-lite/contracts';
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeEventListener,
  RuntimeStatus,
} from './agent-runtime.interface';
import { RunnerRegistryService } from '../runners/runner-registry.service';

/**
 * Server-side adapter for a runner-hosted CLI runtime.
 *
 * The Nest process never spawns a CLI. It only sends a validated dispatch
 * message to the runner that owns the agent's computer.
 */
export class RunnerRuntimeService implements AgentRuntime {
  private readonly active = new Map<string, { runnerId: string; startedAt: number }>();

  constructor(
    readonly type: RunnerRuntimeType,
    private readonly runners: RunnerRegistryService,
  ) {}

  async start(context: RuntimeContext): Promise<void> {
    if (!context.runnerId) {
      throw new Error(`${this.type} runtime requires a connected runner`);
    }
    const prompt = buildPrompt(context);
    await this.runners.dispatchStart({
      runnerId: context.runnerId,
      executionId: context.executionId,
      runtime: this.type,
      taskId: context.taskId,
      taskTitle: context.taskTitle,
      taskDescription: context.taskDescription ?? '',
      projectId: context.projectId ?? '',
      prompt,
      options: context.options,
    });
    this.active.set(context.executionId, {
      runnerId: context.runnerId,
      startedAt: Date.now(),
    });
  }

  async stop(executionId: string): Promise<void> {
    const active = this.active.get(executionId);
    if (!active) {
      return;
    }
    this.runners.dispatchCancel(active.runnerId, executionId, 'Cancelled by operator');
  }

  async getStatus(executionId: string): Promise<RuntimeStatus | null> {
    const active = this.active.get(executionId);
    if (!active) {
      return null;
    }
    return {
      executionId,
      status: 'running',
      phase: 'running',
      progress: 0,
      progressMode: 'indeterminate',
      step: 0,
    };
  }

  /**
   * Runner events are subscribed once by RuntimeRegistryService so multiple
   * runner-backed runtimes cannot duplicate the same event.
   */
  onEvent(_listener: RuntimeEventListener): () => void {
    void _listener;
    return () => undefined;
  }

  markFinished(executionId: string): void {
    this.active.delete(executionId);
  }

  knownRunner(executionId: string): string | null {
    return this.active.get(executionId)?.runnerId ?? null;
  }
}

function buildPrompt(context: RuntimeContext): string {
  const lines = [
    `You are ${context.agentName}, working on a software task in an isolated Git worktree.`,
    `Task: ${context.taskTitle}`,
  ];
  if (context.taskDescription?.trim()) {
    lines.push('', 'Task description:', context.taskDescription.trim());
  }
  lines.push(
    '',
    'Implement the task in the current worktree. Run relevant checks when possible.',
    'Do not commit, push, merge, or modify files outside this worktree.',
    'Finish with a concise summary of what changed and any remaining risk.',
  );
  return lines.join('\n');
}
