import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  ExecutionPhase,
  ExecutionStartMessage,
  GitExecutionResult,
  ProgressMode,
  RunnerLogEntry,
  RunnerRuntimeType,
} from '@raft-lite/contracts';
import type { RunnerConfig } from './config';
import { buildCliArgs } from './cli-args';
import {
  createCliOutputParser,
  type CliLogLine,
  type CliOutputParser,
} from './cli-output';
import type {
  CancelledPayload,
  CompletedPayload,
  ExecutorCallbacks,
  FailedPayload,
  RunnerExecutor,
  RunnerSessionView,
} from './executor';
import { GitWorktreeError, GitWorktreeManager, type WorktreeInfo } from './git-worktree';
import {
  buildCliEnvironment,
  errorMessage,
  resolveExecutable,
  terminateProcess,
} from './process-utils';

const MAX_PENDING_LOGS = 10_000;
const CANCEL_GRACE_MS = 5_000;
const TERMINAL_FALLBACK_MS = 15_000;

interface RealSession extends RunnerSessionView {
  taskTitle: string;
  pending: Map<number, RunnerLogEntry>;
  cancelled: boolean;
  cancelReason: string | null;
  timedOut: boolean;
  finished: boolean;
  child: ChildProcess | null;
  parser: CliOutputParser;
  worktree: WorktreeInfo | null;
  projectPath: string | null;
  timeoutTimer: NodeJS.Timeout | null;
  forceKillTimer: NodeJS.Timeout | null;
  fallbackTimer: NodeJS.Timeout | null;
  sawOutput: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface FinalizeResult {
  reason?: string;
  exitCode?: number | null;
  summary?: string | null;
}

class RunnerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RunnerFailure';
  }
}

/**
 * Executes codex/opencode inside a dedicated Git worktree.
 *
 * The server never sees the process handle, the runner token is stripped from
 * the child environment, and cancellation is only reported after the process
 * has actually exited or been force-terminated.
 */
export class RealExecutor implements RunnerExecutor {
  private readonly sessions = new Map<string, RealSession>();
  private readonly git: GitWorktreeManager;

  constructor(
    private readonly config: RunnerConfig,
    private readonly callbacks: ExecutorCallbacks,
  ) {
    this.git = new GitWorktreeManager(config);
  }

  start(payload: ExecutionStartMessage['payload']): void {
    if (!this.config.realRuntimes.includes(payload.runtime)) {
      this.failBeforeStart(
        payload,
        `RUNTIME_NOT_ENABLED: ${payload.runtime} is not enabled for this runner`,
      );
      return;
    }
    if (this.sessions.has(payload.executionId)) {
      return;
    }
    if (this.sessions.size >= this.config.maxConcurrentExecutions) {
      this.failBeforeStart(
        payload,
        'RUNNER_BUSY: maximum concurrent executions reached',
      );
      return;
    }

    const session = this.createSession(payload);
    this.sessions.set(session.executionId, session);
    this.emitPhase(session, 'preparing', 'Runner accepted the execution');
    this.log(
      session,
      'system',
      'info',
      `Real ${payload.runtime} runner accepted the execution.`,
    );

    void this.prepareAndRun(session, payload).catch((error: unknown) => {
      if (session.cancelled) {
        void this.finalize(session, 'cancelled', {
          reason: session.cancelReason ?? 'Cancelled by operator',
          exitCode: null,
          summary: null,
        });
        return;
      }
      this.fail(session, this.describeError(error));
    });
  }

  cancel(executionId: string, reason?: string): void {
    const session = this.sessions.get(executionId);
    if (!session || session.finished || session.cancelled) {
      return;
    }
    session.cancelled = true;
    session.cancelReason = reason?.trim() || 'Cancelled by operator';
    this.log(
      session,
      'system',
      'warning',
      `Cancellation requested: ${session.cancelReason}`,
    );

    const child = session.child;
    if (!child) {
      // prepareAndRun checks the cancelled flag before spawning.
      return;
    }

    void terminateProcess(child, false);
    session.forceKillTimer = setTimeout(() => {
      if (!session.finished) {
        void terminateProcess(child, true);
      }
    }, CANCEL_GRACE_MS);
    this.scheduleTerminalFallback(session, 'cancelled');
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

  shutdown(reason = 'Runner shutting down'): void {
    for (const session of [...this.sessions.values()]) {
      this.cancel(session.executionId, reason);
    }
  }

  private async prepareAndRun(
    session: RealSession,
    payload: ExecutionStartMessage['payload'],
  ): Promise<void> {
    const projectPath = this.config.projectPaths[payload.projectId];
    if (!projectPath) {
      throw new RunnerFailure(
        'PROJECT_NOT_MAPPED',
        `${payload.projectId} is not configured on this runner`,
      );
    }
    session.projectPath = projectPath;

    const worktree = await this.git.prepare(
      projectPath,
      payload.projectId,
      payload.executionId,
    );
    session.worktree = worktree;
    this.log(
      session,
      'system',
      'info',
      `Isolated Git worktree ready on branch ${worktree.branchName}.`,
    );
    this.emitProgress(session, 5, 0, 'indeterminate');

    if (session.cancelled) {
      await this.finalize(session, 'cancelled', {
        reason: session.cancelReason ?? 'Cancelled by operator',
        exitCode: null,
        summary: null,
      });
      return;
    }

    const command = this.config.cliPaths[payload.runtime] ?? payload.runtime;
    const resolved = await resolveExecutable(command);
    if (!resolved.path) {
      throw new RunnerFailure(
        'CLI_NOT_INSTALLED',
        resolved.error ?? `${payload.runtime} CLI was not found`,
      );
    }
    if (session.cancelled) {
      await this.finalize(session, 'cancelled', {
        reason: session.cancelReason ?? 'Cancelled by operator',
        exitCode: null,
        summary: null,
      });
      return;
    }

    const args = buildCliArgs(payload.runtime, payload, worktree.path, this.config);
    this.emitPhase(session, 'running', 'CLI process started');
    this.log(
      session,
      'system',
      'info',
      `Starting the ${payload.runtime} CLI in the isolated worktree.`,
    );

    let child: ChildProcess;
    try {
      child = spawn(resolved.path, args, {
        cwd: worktree.path,
        env: buildCliEnvironment(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new RunnerFailure('CLI_SPAWN_FAILED', errorMessage(error));
    }

    session.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const onOutput = (stream: 'stdout' | 'stderr') => (chunk: string | Buffer) => {
      if (session.finished) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of session.parser.push(text, stream)) {
        this.writeParsed(session, line);
      }
    };
    child.stdout?.on('data', onOutput('stdout'));
    child.stderr?.on('data', onOutput('stderr'));

    child.stdin?.on('error', () => {
      // The CLI may exit before consuming the whole prompt; the close handler
      // reports the real outcome.
    });
    child.once('error', (error) => {
      this.fail(session, `CLI_SPAWN_FAILED: ${errorMessage(error)}`);
    });
    child.once('close', (code, signal) => {
      void this.finishFromClose(session, code, signal);
    });

    const timeoutMs = Math.min(
      payload.options.timeoutMs ?? this.config.cliTimeoutMs,
      this.config.cliTimeoutMs,
    );
    session.timeoutTimer = setTimeout(() => {
      if (session.finished) return;
      session.timedOut = true;
      this.log(
        session,
        'stderr',
        'error',
        `CLI exceeded the ${timeoutMs}ms timeout and will be terminated.`,
      );
      void terminateProcess(child, true);
      this.scheduleTerminalFallback(session, 'timeout');
    }, timeoutMs);

    try {
      child.stdin?.end(payload.prompt);
    } catch (error) {
      this.fail(session, `CLI_STDIN_FAILED: ${errorMessage(error)}`);
      return;
    }

    if (session.cancelled) {
      void terminateProcess(child, true);
      this.scheduleTerminalFallback(session, 'cancelled');
    }
  }

  private async finishFromClose(
    session: RealSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (session.finished) return;
    session.exitCode = code;
    session.signal = signal;

    if (session.cancelled) {
      await this.finalize(session, 'cancelled', {
        reason: session.cancelReason ?? 'Cancelled by operator',
        exitCode: code,
        summary: session.parser.lastSummary(),
      });
      return;
    }

    if (session.timedOut) {
      await this.finalize(session, 'failed', {
        reason: `CLI_TIMEOUT: the ${session.runtime} CLI exceeded its execution timeout`,
        exitCode: code,
        summary: session.parser.lastSummary(),
      });
      return;
    }

    if (code === 0) {
      await this.finalize(session, 'completed', {
        exitCode: 0,
        summary: session.parser.lastSummary(),
      });
      return;
    }

    const detail = session.parser.lastError();
    const status = code === null ? (signal ?? 'unknown signal') : `exit code ${code}`;
    await this.finalize(session, 'failed', {
      reason: `CLI_EXIT_CODE: ${status}${detail ? `: ${detail}` : ''}`,
      exitCode: code,
      summary: session.parser.lastSummary(),
    });
  }

  private async finalize(
    session: RealSession,
    outcome: 'completed' | 'failed' | 'cancelled',
    result: FinalizeResult,
  ): Promise<void> {
    if (session.finished) return;
    session.finished = true;
    this.clearTimers(session);

    for (const line of session.parser.flush()) {
      this.writeParsed(session, line);
    }

    if (outcome === 'completed') {
      this.emitPhase(session, 'finalizing', 'Collecting the Git result');
    }

    const git = await this.collectGit(session);
    session.phase = outcome;

    if (outcome === 'completed') {
      const summary =
        result.summary?.trim() ||
        session.parser.lastSummary() ||
        `${session.runtime} CLI completed without a final summary.`;
      this.log(session, 'system', 'success', 'CLI process exited successfully.');
      this.emitProgress(session, 100, 0, 'determinate');
      const payload: CompletedPayload = {
        exitCode: result.exitCode ?? 0,
        summary: summary.slice(0, 20_000),
        git,
      };
      this.callbacks.onCompleted(session, payload);
    } else if (outcome === 'failed') {
      const reason = (result.reason ?? 'CLI execution failed').slice(0, 2000);
      this.log(session, 'stderr', 'error', reason);
      const payload: FailedPayload = {
        reason,
        exitCode: result.exitCode ?? null,
        summary: result.summary ?? session.parser.lastSummary(),
        git,
      };
      this.callbacks.onFailed(session, payload);
    } else {
      const reason = result.reason?.trim() || 'Cancelled by operator';
      this.log(
        session,
        'system',
        'warning',
        `CLI process stopped; cancellation confirmed: ${reason}`,
      );
      const payload: CancelledPayload = {
        reason,
        exitCode: result.exitCode ?? null,
        git,
      };
      this.callbacks.onCancelled(session, payload);
    }

    this.sessions.delete(session.executionId);
    await this.cleanupWorktree(session);
  }

  private collectGit(session: RealSession): Promise<GitExecutionResult | null> {
    if (!session.worktree) return Promise.resolve(null);
    return this.git.collect(session.worktree);
  }

  private async cleanupWorktree(session: RealSession): Promise<void> {
    if (!session.worktree || !session.projectPath) return;
    try {
      await this.git.cleanup(session.worktree, session.projectPath);
    } catch {
      // Cleanup is best-effort; the worktree path is kept for manual recovery.
    }
  }

  private fail(session: RealSession, reason: string): void {
    if (session.finished) return;
    void this.finalize(session, 'failed', {
      reason,
      exitCode: session.exitCode,
      summary: session.parser.lastSummary(),
    });
  }

  private failBeforeStart(
    payload: ExecutionStartMessage['payload'],
    reason: string,
  ): void {
    const session = this.createSession(payload);
    this.emitPhase(session, 'failed', null);
    this.log(session, 'stderr', 'error', reason);
    this.callbacks.onFailed(session, {
      reason,
      exitCode: null,
      summary: null,
      git: null,
    });
  }

  private scheduleTerminalFallback(
    session: RealSession,
    outcome: 'cancelled' | 'timeout',
  ): void {
    if (session.fallbackTimer) return;
    session.fallbackTimer = setTimeout(() => {
      if (session.finished) return;
      if (session.child) {
        void terminateProcess(session.child, true);
      }
      if (outcome === 'timeout') {
        this.fail(
          session,
          `CLI_TIMEOUT: the ${session.runtime} CLI did not exit after being terminated`,
        );
        return;
      }
      void this.finalize(session, 'cancelled', {
        reason: session.cancelReason ?? 'Cancelled by operator',
        exitCode: session.exitCode,
        summary: session.parser.lastSummary(),
      });
    }, TERMINAL_FALLBACK_MS);
  }

  private writeParsed(session: RealSession, line: CliLogLine): void {
    this.log(session, line.stream, line.level, line.message);
    if (!session.sawOutput && (line.stream === 'stdout' || line.stream === 'stderr')) {
      session.sawOutput = true;
      this.emitProgress(session, 50, 0, 'indeterminate');
    }
  }

  private emitPhase(
    session: RealSession,
    phase: ExecutionPhase,
    message: string | null,
  ): void {
    session.phase = phase;
    this.callbacks.onPhase(session, phase, message);
  }

  private emitProgress(
    session: RealSession,
    progress: number,
    step: number,
    progressMode: ProgressMode,
  ): void {
    this.callbacks.onProgress(session, progress, step, progressMode);
  }

  private log(
    session: RealSession,
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
    if (session.pending.size >= MAX_PENDING_LOGS) {
      const oldest = session.pending.keys().next().value;
      if (typeof oldest === 'number') {
        session.pending.delete(oldest);
      }
    }
    session.pending.set(entry.sequence, entry);
    this.callbacks.onLog(session, entry);
  }

  private createSession(payload: ExecutionStartMessage['payload']): RealSession {
    return {
      executionId: payload.executionId,
      runtime: payload.runtime,
      phase: 'preparing',
      lastSeq: 0,
      startedAt: new Date().toISOString(),
      taskTitle: payload.taskTitle,
      pending: new Map(),
      cancelled: false,
      cancelReason: null,
      timedOut: false,
      finished: false,
      child: null,
      parser: createCliOutputParser(payload.runtime),
      worktree: null,
      projectPath: null,
      timeoutTimer: null,
      forceKillTimer: null,
      fallbackTimer: null,
      sawOutput: false,
      exitCode: null,
      signal: null,
    };
  }

  private clearTimers(session: RealSession): void {
    if (session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = null;
    }
    if (session.forceKillTimer) {
      clearTimeout(session.forceKillTimer);
      session.forceKillTimer = null;
    }
    if (session.fallbackTimer) {
      clearTimeout(session.fallbackTimer);
      session.fallbackTimer = null;
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof GitWorktreeError || error instanceof RunnerFailure) {
      return error.message.slice(0, 2000);
    }
    return `RUNNER_ERROR: ${errorMessage(error)}`.slice(0, 2000);
  }
}
