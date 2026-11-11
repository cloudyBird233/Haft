import { randomUUID } from 'node:crypto';
import type {
  ExecutionPhase,
  ExecutionStartMessage,
  GitExecutionResult,
  RunnerLogEntry,
  RunnerRuntimeType,
} from '@raft-lite/contracts';
import type { RunnerConfig } from './config';
import type {
  ExecutorAdmission,
  ExecutorCallbacks,
  RunnerExecutor,
  ShutdownResult,
} from './executor';
import type { RepositoryContext } from './repository-context';

export type { CancelledPayload, CompletedPayload, ExecutorCallbacks, FailedPayload } from './executor';

export interface FakeSession {
  executionId: string;
  runtime: RunnerRuntimeType;
  phase: ExecutionPhase;
  lastSeq: number;
  startedAt: string;
  taskTitle: string;
  pending: Map<number, RunnerLogEntry>;
  timer: NodeJS.Timeout | null;
  cancelled: boolean;
}

interface FakeStep {
  progress: number;
  message: string;
  level: RunnerLogEntry['level'];
}

const STEPS: readonly FakeStep[] = [
  { progress: 10, message: 'Fake runner prepared an isolated worktree.', level: 'info' },
  { progress: 30, message: 'Fake runner inspected repository conventions.', level: 'info' },
  { progress: 50, message: 'Fake runner applied simulated implementation changes.', level: 'info' },
  { progress: 70, message: 'Fake runner updated simulated tests.', level: 'info' },
  { progress: 85, message: 'Fake runner validated the simulated diff.', level: 'success' },
  { progress: 95, message: 'Fake runner collected the simulated Git result.', level: 'info' },
];

/**
 * Deterministic runner-side execution engine used before a real CLI is wired.
 *
 * It exercises the complete server/runner/database/UI path without calling a
 * model or a shell, so protocol and recovery failures stay reproducible.
 */
export class FakeExecutor implements RunnerExecutor {
  private readonly sessions = new Map<string, FakeSession>();

  constructor(
    private readonly config: RunnerConfig,
    private readonly callbacks: ExecutorCallbacks,
  ) {}

  canAdmit(
    payload: ExecutionStartMessage['payload'],
    _context: RepositoryContext,
  ): ExecutorAdmission {
    if (!this.config.fakeRuntimes.includes(payload.runtime)) {
      return {
        ok: false,
        code: 'REPOSITORY_CONTEXT_NOT_READY',
        message: `RUNTIME_NOT_ENABLED: ${payload.runtime} is not enabled for this runner`,
        retryable: false,
      };
    }
    if (this.sessions.has(payload.executionId)) {
      return { ok: true };
    }
    if (this.sessions.size >= this.config.maxConcurrentExecutions) {
      return {
        ok: false,
        code: 'REPOSITORY_CONTEXT_NOT_READY',
        message: 'RUNNER_BUSY: maximum concurrent executions reached',
        retryable: true,
      };
    }
    return { ok: true };
  }

  start(payload: ExecutionStartMessage['payload'], context: RepositoryContext): void {
    if (this.sessions.has(payload.executionId)) {
      return;
    }

    const session = this.createSession(payload);
    this.sessions.set(session.executionId, session);
    this.callbacks.onPhase(session, 'preparing', 'Runner accepted the execution');
    this.log(session, 'system', 'info', `Fake runner accepted ${payload.runtime} execution.`);
    this.log(
      session,
      'system',
      'info',
      `Repository context ${context.contextId} prepared for ${context.defaultBranch}; simulated worktree created.`,
    );

    if (this.shouldFail(payload)) {
      this.log(session, 'stderr', 'warning', 'Fake failure mode was requested by the task.');
    }

    let stepIndex = 0;
    const tick = (): void => {
      if (session.cancelled) return;
      if (stepIndex === 0) {
        this.callbacks.onPhase(session, 'running', 'Execution is running');
        this.callbacks.onProgress(session, 5, 0);
      }
      if (stepIndex >= STEPS.length) {
        this.finish(session, payload);
        return;
      }
      const step = STEPS[stepIndex];
      if (!step) {
        this.finish(session, payload);
        return;
      }
      stepIndex += 1;
      this.log(
        session,
        step.level === 'warning' ? 'stderr' : 'stdout',
        step.level,
        step.message,
      );
      this.callbacks.onProgress(session, step.progress, stepIndex);

      if (this.shouldFail(payload) && stepIndex === 3) {
        this.fail(session, payload);
        return;
      }
      session.timer = setTimeout(tick, this.config.stepMs);
    };
    session.timer = setTimeout(tick, this.config.stepMs);
  }

  cancel(executionId: string, reason?: string): void {
    const session = this.sessions.get(executionId);
    if (!session || session.cancelled) {
      return;
    }
    session.cancelled = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    this.log(
      session,
      'system',
      'warning',
      `Cancellation requested: ${reason?.trim() || 'Cancelled by operator'}`,
    );
    const delay = Math.min(100, this.config.stepMs);
    setTimeout(() => {
      if (!this.sessions.has(executionId)) return;
      this.callbacks.onCancelled(session, {
        reason: reason?.trim() || 'Cancelled by operator',
        exitCode: null,
        git: this.fakeGitResult(executionId),
      });
      this.sessions.delete(executionId);
    }, delay);
  }

  acknowledge(executionId: string, throughSeq: number): void {
    const session = this.sessions.get(executionId);
    if (!session) return;
    for (const seq of session.pending.keys()) {
      if (seq <= throughSeq) {
        session.pending.delete(seq);
      }
    }
  }

  pendingLogs(executionId: string): RunnerLogEntry[] {
    const session = this.sessions.get(executionId);
    if (!session) return [];
    return [...session.pending.values()].sort((left, right) => left.sequence - right.sequence);
  }

  pendingLogCount(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.pending.size;
    }
    return total;
  }

  snapshot(): Array<{
    executionId: string;
    phase: ExecutionPhase;
    lastSeq: number;
    startedAt: string;
    runtime: RunnerRuntimeType;
  }> {
    return [...this.sessions.values()].map((session) => ({
      executionId: session.executionId,
      phase: session.phase,
      lastSeq: session.lastSeq,
      startedAt: session.startedAt,
      runtime: session.runtime,
    }));
  }

  activeExecutionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async shutdown(reason = 'Runner shutting down'): Promise<ShutdownResult> {
    const initial = [...this.sessions.keys()];
    for (const executionId of initial) {
      this.cancel(executionId, reason);
    }
    const clean = await waitFor(() => this.sessions.size === 0, 3000);
    return {
      clean,
      remainingExecutionIds: [...this.sessions.keys()],
      forced: false,
    };
  }

  private createSession(payload: ExecutionStartMessage['payload']): FakeSession {
    return {
      executionId: payload.executionId,
      runtime: payload.runtime,
      phase: 'preparing',
      lastSeq: 0,
      startedAt: new Date().toISOString(),
      taskTitle: payload.taskTitle,
      pending: new Map(),
      timer: null,
      cancelled: false,
    };
  }

  private finish(session: FakeSession, payload: ExecutionStartMessage['payload']): void {
    this.callbacks.onPhase(session, 'finalizing', 'Collecting simulated Git result');
    this.log(session, 'stdout', 'success', 'Fake runner completed all simulated steps.');
    this.callbacks.onProgress(session, 100, STEPS.length);
    this.callbacks.onCompleted(session, {
      exitCode: 0,
      summary: `Fake runner completed "${payload.taskTitle}" without invoking a real model.`,
      git: this.fakeGitResult(session.executionId),
    });
    this.sessions.delete(session.executionId);
  }

  private fail(session: FakeSession, payload: ExecutionStartMessage['payload']): void {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    this.callbacks.onPhase(session, 'failed', 'Fake failure path');
    this.log(
      session,
      'stderr',
      'error',
      'FAKE_RUNNER_FAILURE: the task requested a deterministic failure.',
    );
    this.callbacks.onFailed(session, {
      reason: 'FAKE_RUNNER_FAILURE: deterministic failure requested by the task',
      exitCode: 2,
      summary: `Fake runner failed "${payload.taskTitle}" on purpose.`,
      git: this.fakeGitResult(session.executionId),
    });
    this.sessions.delete(session.executionId);
  }

  private log(
    session: FakeSession,
    stream: RunnerLogEntry['stream'],
    level: RunnerLogEntry['level'],
    message: string,
  ): void {
    session.lastSeq += 1;
    const entry: RunnerLogEntry = {
      sequence: session.lastSeq,
      eventId: randomUUID(),
      stream,
      level,
      message: message.slice(0, 8000),
      timestamp: new Date().toISOString(),
    };
    session.pending.set(entry.sequence, entry);
    this.callbacks.onLog(session, entry);
  }

  private shouldFail(payload: ExecutionStartMessage['payload']): boolean {
    return (
      process.env.HAFT_RUNNER_FAKE_FAIL === '1' ||
      payload.taskTitle.includes('[fail]') ||
      payload.taskDescription.includes('HAFT_FAKE_FAIL')
    );
  }

  private fakeGitResult(executionId: string): GitExecutionResult {
    return {
      branchName: `haft/${sanitize(executionId)}`,
      baseCommit: '0'.repeat(40),
      headCommit: 'f'.repeat(40),
      changedFiles: 2,
      diffStat:
        ' packages/example/src/feature.ts | 42 ++++++++++++++++++++++++++++++++----\n' +
        ' packages/example/test/feature.spec.ts | 18 ++++++++++++++++++\n' +
        ' 2 files changed, 56 insertions(+), 4 deletions(-)',
      gitStatus:
        ' M packages/example/src/feature.ts\n?? packages/example/test/feature.spec.ts',
      diff: [
        'diff --git a/packages/example/src/feature.ts b/packages/example/src/feature.ts',
        'index 1111111..2222222 100644',
        '--- a/packages/example/src/feature.ts',
        '+++ b/packages/example/src/feature.ts',
        '@@ -1,3 +1,4 @@',
        ' export function feature() {',
        '-  return "old";',
        '+  return "simulated";',
        ' }',
        'diff --git a/packages/example/test/feature.spec.ts b/packages/example/test/feature.spec.ts',
        'new file mode 100644',
        'index 0000000..3333333',
        '--- /dev/null',
        '+++ b/packages/example/test/feature.spec.ts',
        '@@ -0,0 +1,2 @@',
        '+import { feature } from "../src/feature";',
        '+// simulated test',
      ].join('\n'),
      diffTruncated: false,
    };
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return condition();
}
