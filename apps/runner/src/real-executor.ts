import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
import { createCliOutputParser, type CliLogLine, type CliOutputParser } from './cli-output';
import type {
  CancelledPayload,
  CompletedPayload,
  ExecutorAdmission,
  ExecutorCallbacks,
  FailedPayload,
  RunnerExecutor,
  RunnerSessionView,
  ShutdownResult,
} from './executor';
import { GitWorktreeError, GitWorktreeManager, type WorktreeInfo } from './git-worktree';
import {
  buildCliEnvironment,
  errorMessage,
  resolveExecutable,
  terminateProcess,
  type ResolvedExecutable,
} from './process-utils';
import { inspectProcess, type ProcessIdentity } from './process-identity';
import type { ExecutionRecovery } from './recovery';
import type { ExecutionJournalPatch } from './execution-journal';
import type { RepositoryPathPolicy } from './repository-policy';
import type { RepositoryContext } from './repository-context';

const MAX_PENDING_LOGS = 10_000;
const CANCEL_GRACE_MS = 5_000;
const TERMINAL_FALLBACK_MS = 15_000;
const SHUTDOWN_FORCE_WAIT_MS = 5_000;

/**
 * Seams for unit tests. Production always uses the Node process primitives and
 * the real Git manager; tests can inject a deterministic child process without
 * starting a CLI or a real worktree.
 */
export interface RealExecutorDependencies {
  resolveExecutable(command: string): Promise<ResolvedExecutable>;
  spawnProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  inspectProcess(pid: number): Promise<ProcessIdentity | null>;
  terminateProcess(child: ChildProcess, force?: boolean): Promise<void>;
  git: Pick<GitWorktreeManager, 'prepare' | 'collect' | 'cleanup'>;
  /**
   * The single path authority. Production always injects the instance built
   * in `main.ts`; a missing policy is treated as REPOSITORY_POLICY_NOT_CONFIGURED
   * so a real execution can never fall back to an unchecked path.
   */
  repositoryPolicy?: RepositoryPathPolicy | null;
  shutdownForceWaitMs: number;
}

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
  processStartTime: string | null;
  processGroupId: number | null;
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
  private readonly git: Pick<GitWorktreeManager, 'prepare' | 'collect' | 'cleanup'>;
  private readonly resolveExecutable: RealExecutorDependencies['resolveExecutable'];
  private readonly spawnProcess: RealExecutorDependencies['spawnProcess'];
  private readonly inspectProcess: RealExecutorDependencies['inspectProcess'];
  private readonly terminateProcess: RealExecutorDependencies['terminateProcess'];
  private readonly repositoryPolicy: RepositoryPathPolicy | null;
  private readonly shutdownForceWaitMs: number;

  constructor(
    private readonly config: RunnerConfig,
    private readonly callbacks: ExecutorCallbacks,
    private readonly recovery?: ExecutionRecovery,
    dependencies: Partial<RealExecutorDependencies> = {},
  ) {
    this.git = dependencies.git ?? new GitWorktreeManager(config);
    this.resolveExecutable = dependencies.resolveExecutable ?? resolveExecutable;
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.inspectProcess = dependencies.inspectProcess ?? inspectProcess;
    this.terminateProcess = dependencies.terminateProcess ?? terminateProcess;
    this.repositoryPolicy = dependencies.repositoryPolicy ?? null;
    this.shutdownForceWaitMs = dependencies.shutdownForceWaitMs ?? SHUTDOWN_FORCE_WAIT_MS;
  }

  canAdmit(
    payload: ExecutionStartMessage['payload'],
    _context: RepositoryContext,
  ): ExecutorAdmission {
    if (!this.config.realRuntimes.includes(payload.runtime)) {
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
    // Admission has already passed. A missing context here is a programming
    // error, not a user-facing pre-start rejection.
    if (!context?.canonicalPath) {
      this.failBeforeStart(
        payload,
        'REPOSITORY_CONTEXT_NOT_READY: No repository context is available on the real execution session',
        false,
      );
      return;
    }

    const session = this.createSession(payload);
    session.projectPath = context.canonicalPath;
    this.sessions.set(session.executionId, session);
    this.emitPhase(session, 'preparing', 'Runner accepted the execution');
    this.log(session, 'system', 'info', `Real ${payload.runtime} runner accepted the execution.`);

    void this.prepareAndRun(session, payload, context).catch((error: unknown) => {
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
    this.log(session, 'system', 'warning', `Cancellation requested: ${session.cancelReason}`);

    const child = session.child;
    if (!child) {
      // prepareAndRun checks the cancelled flag before spawning.
      return;
    }

    void this.terminateProcess(child, false);
    session.forceKillTimer = setTimeout(() => {
      if (!session.finished) {
        void this.terminateProcess(child, true);
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

  async shutdown(reason = 'Runner shutting down'): Promise<ShutdownResult> {
    const initial = [...this.sessions.keys()];
    if (initial.length === 0) {
      return { clean: true, remainingExecutionIds: [], forced: false };
    }
    for (const executionId of initial) {
      this.cancel(executionId, reason);
    }

    let forced = false;
    let clean = await waitFor(() => this.sessions.size === 0, this.config.shutdownGraceMs);
    if (!clean) {
      forced = true;
      for (const session of this.sessions.values()) {
        this.log(
          session,
          'system',
          'warning',
          'Graceful shutdown timed out; force-terminating the CLI process tree.',
        );
        if (session.child) {
          await this.terminateProcess(session.child, true);
        } else {
          await this.finalize(session, 'cancelled', {
            reason: `${reason}: the CLI had not started`,
            exitCode: null,
            summary: null,
          });
        }
      }
      clean = await waitFor(() => this.sessions.size === 0, this.shutdownForceWaitMs);
    }

    return {
      clean,
      remainingExecutionIds: [...this.sessions.keys()],
      forced,
    };
  }

  private async prepareAndRun(
    session: RealSession,
    payload: ExecutionStartMessage['payload'],
    context: RepositoryContext,
  ): Promise<void> {
    // Invariant established by `start()`. Never pass '' to git.prepare: it
    // would resolve to the runner process cwd and silently reintroduce the
    // cwd fallback that fail-closed removed.
    if (!session.projectPath) {
      throw new RunnerFailure(
        'PROJECT_BINDING_UNSUPPORTED',
        'No repository context is available on the real execution session',
      );
    }
    if (!this.repositoryPolicy) {
      throw new RunnerFailure(
        'REPOSITORY_POLICY_NOT_CONFIGURED',
        'The runner has no repository path policy',
      );
    }
    // TOCTOU guard: re-check allowed-root containment and bidirectional
    // worktree/recovery isolation immediately before the journal/worktree.
    await this.repositoryPolicy.assertStillAllowed(context.canonicalPath);
    await this.beginJournal(session, payload);

    const worktree = await this.git.prepare(
      session.projectPath,
      payload.projectId,
      payload.executionId,
      { baseCommit: context.baseCommit },
    );
    session.worktree = worktree;
    await this.persistJournal(
      session,
      {
        worktreePath: worktree.path,
        branchName: worktree.branchName,
        baseCommit: worktree.baseCommit,
        phase: session.phase,
      },
      true,
    );
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
    const resolved = await this.resolveExecutable(command);
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
      child = this.spawnProcess(resolved.path, args, {
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

    const pid = child.pid ?? null;
    if (pid) {
      const identity = await this.inspectProcess(pid).catch(() => null);
      session.processStartTime = identity?.startTime ?? null;
      session.processGroupId = identity?.processGroupId ?? pid;
      await this.persistJournal(
        session,
        {
          pid,
          processStartTime: session.processStartTime,
          processGroupId: session.processGroupId,
          phase: session.phase,
        },
        true,
      );
    }

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
      void this.terminateProcess(child, true);
      this.scheduleTerminalFallback(session, 'timeout');
    }, timeoutMs);

    try {
      child.stdin?.end(payload.prompt);
    } catch (error) {
      this.fail(session, `CLI_STDIN_FAILED: ${errorMessage(error)}`);
      return;
    }

    if (session.cancelled) {
      void this.terminateProcess(child, true);
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
    await this.finishJournal(session, outcome);

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
    persistJournal = true,
  ): void {
    const session = this.createSession(payload);
    this.emitPhase(session, 'failed', null, persistJournal);
    this.log(session, 'stderr', 'error', reason, persistJournal);
    this.callbacks.onFailed(session, {
      reason,
      exitCode: null,
      summary: null,
      git: null,
    });
  }

  private scheduleTerminalFallback(session: RealSession, outcome: 'cancelled' | 'timeout'): void {
    if (session.fallbackTimer) return;
    session.fallbackTimer = setTimeout(() => {
      if (session.finished) return;
      if (session.child) {
        void this.terminateProcess(session.child, true);
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
    persistJournal = true,
  ): void {
    session.phase = phase;
    if (persistJournal) {
      void this.persistJournal(session, { phase, status: 'active' }, true);
    }
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
    persistJournal = true,
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
    if (persistJournal) {
      void this.persistJournal(
        session,
        { lastSequence: session.lastSeq, phase: session.phase, status: 'active' },
        false,
      );
    }
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
      processStartTime: null,
      processGroupId: null,
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

  private async beginJournal(
    session: RealSession,
    payload: ExecutionStartMessage['payload'],
  ): Promise<void> {
    if (!this.recovery) return;
    try {
      await this.recovery.journal.begin({
        version: 1,
        executionId: session.executionId,
        runtime: session.runtime,
        projectId: payload.projectId,
        pid: null,
        processStartTime: null,
        processGroupId: null,
        worktreePath: session.worktree?.path ?? null,
        branchName: session.worktree?.branchName ?? null,
        baseCommit: session.worktree?.baseCommit ?? null,
        phase: session.phase,
        status: 'active',
        lastSequence: session.lastSeq,
        startedAt: session.startedAt,
        updatedAt: new Date().toISOString(),
        finishedAt: null,
      });
    } catch (error) {
      this.log(
        session,
        'system',
        'warning',
        `Recovery journal could not be written: ${errorMessage(error)}`,
      );
    }
  }

  private persistJournal(
    session: RealSession,
    patch: ExecutionJournalPatch,
    immediate: boolean,
  ): Promise<void> {
    if (!this.recovery || session.finished) return Promise.resolve();
    return this.recovery.journal
      .update(session.executionId, patch, { immediate })
      .catch(() => undefined);
  }

  private async finishJournal(
    session: RealSession,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    if (!this.recovery) return;
    try {
      await this.recovery.journal.finish(session.executionId, outcome, outcome, session.lastSeq);
    } catch {
      // Recovery metadata is best-effort; the terminal protocol event is the
      // authoritative outcome.
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof GitWorktreeError || error instanceof RunnerFailure) {
      return error.message.slice(0, 2000);
    }
    return `RUNNER_ERROR: ${errorMessage(error)}`.slice(0, 2000);
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return condition();
}
