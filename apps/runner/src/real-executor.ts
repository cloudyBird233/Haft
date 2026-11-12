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
import { probeAuthentication, type AuthProbeResult } from './cli-probe';
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
import { inspectProcess, waitForProcessExit, type ProcessIdentity } from './process-identity';
import type { ExecutionRecovery } from './recovery';
import type { ExecutionJournalPatch } from './execution-journal';
import type { RepositoryPathPolicy } from './repository-policy';
import type { RepositoryContext } from './repository-context';

const MAX_PENDING_LOGS = 10_000;
const CANCEL_GRACE_MS = 5_000;
const TERMINAL_FALLBACK_MS = 15_000;
const SHUTDOWN_FORCE_WAIT_MS = 5_000;
/** How long a journal-failure abort waits for verified process-tree exit. */
const JOURNAL_ABORT_CONFIRM_MS = 5_000;

/**
 * Seams for unit tests. Production always uses the Node process primitives and
 * the real Git manager; tests can inject a deterministic child process without
 * starting a CLI or a real worktree.
 */
export interface RealExecutorDependencies {
  resolveExecutable(command: string): Promise<ResolvedExecutable>;
  probeAuthentication(runtime: RunnerRuntimeType, executable: string): Promise<AuthProbeResult>;
  spawnProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  inspectProcess(pid: number): Promise<ProcessIdentity | null>;
  terminateProcess(child: ChildProcess, force?: boolean): Promise<void>;
  waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
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
  executablePath: string | null;
  timeoutTimer: NodeJS.Timeout | null;
  forceKillTimer: NodeJS.Timeout | null;
  fallbackTimer: NodeJS.Timeout | null;
  sawOutput: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processStartTime: string | null;
  processGroupId: number | null;
  /** True only after the initial journal record was durably written. */
  journalStarted: boolean;
  /** Set while a journal failure is terminating the child; suppresses close finalization. */
  journalAborted: boolean;
  /** Latched journal failure so every later preparation step fails closed. */
  journalError: string | null;
  /** True until the spawned PID and its start marker are durable. */
  identityPending: boolean;
  /** A close event that arrived while the identity was still being persisted. */
  pendingExit: { code: number | null; signal: NodeJS.Signals | null } | null;
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
  /** Executions whose process death could not be confirmed after a journal failure. */
  private readonly uncertainOrphans = new Set<string>();
  /** Executable resolved by live admission and reused by the following start. */
  private readonly admittedExecutables = new Map<string, string>();
  private readonly git: Pick<GitWorktreeManager, 'prepare' | 'collect' | 'cleanup'>;
  private readonly resolveExecutable: RealExecutorDependencies['resolveExecutable'];
  private readonly probeAuthentication: RealExecutorDependencies['probeAuthentication'];
  private readonly spawnProcess: RealExecutorDependencies['spawnProcess'];
  private readonly inspectProcess: RealExecutorDependencies['inspectProcess'];
  private readonly terminateProcess: RealExecutorDependencies['terminateProcess'];
  private readonly waitForProcessExit: RealExecutorDependencies['waitForProcessExit'];
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
    this.probeAuthentication = dependencies.probeAuthentication ?? probeAuthentication;
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.inspectProcess = dependencies.inspectProcess ?? inspectProcess;
    this.terminateProcess = dependencies.terminateProcess ?? terminateProcess;
    this.waitForProcessExit = dependencies.waitForProcessExit ?? waitForProcessExit;
    this.repositoryPolicy = dependencies.repositoryPolicy ?? null;
    this.shutdownForceWaitMs = dependencies.shutdownForceWaitMs ?? SHUTDOWN_FORCE_WAIT_MS;
    this.recovery?.journal.setBackgroundErrorHandler?.((executionId, error) => {
      const session = this.sessions.get(executionId);
      if (!session) return;
      this.handleJournalFailure(session, error);
    });
  }

  async canAdmit(
    payload: ExecutionStartMessage['payload'],
    _context: RepositoryContext,
  ): Promise<ExecutorAdmission> {
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

    // Live admission: the startup capability cache is not evidence that the
    // CLI still exists or is still authenticated when execution.start arrives.
    const command = this.config.cliPaths[payload.runtime] ?? payload.runtime;
    let resolved: Awaited<ReturnType<RealExecutorDependencies['resolveExecutable']>>;
    try {
      resolved = await this.resolveExecutable(command);
    } catch (error) {
      return {
        ok: false,
        code: 'REPOSITORY_CONTEXT_NOT_READY',
        message: `CLI_NOT_INSTALLED: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 2000),
        retryable: false,
      };
    }
    if (!resolved.path) {
      return {
        ok: false,
        code: 'REPOSITORY_CONTEXT_NOT_READY',
        message: `CLI_NOT_INSTALLED: ${
          resolved.error ?? `${payload.runtime} CLI was not found`
        }`.slice(0, 2000),
        retryable: false,
      };
    }

    let auth: AuthProbeResult;
    try {
      auth = await this.probeAuthentication(payload.runtime, resolved.path);
    } catch (error) {
      return {
        ok: false,
        code: 'REPOSITORY_CONTEXT_NOT_READY',
        message: `CLI_NOT_AUTHENTICATED: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 2000),
        retryable: false,
      };
    }
    if (!auth.authenticated) {
      return {
        ok: false,
        code: 'REPOSITORY_CONTEXT_NOT_READY',
        message: `CLI_NOT_AUTHENTICATED: ${
          auth.message ?? `${payload.runtime} CLI is not authenticated`
        }`.slice(0, 2000),
        retryable: false,
      };
    }

    // Keep the exact executable resolved by admission so start does not
    // repeat an ordinary "is it installed?" decision after accepted.
    this.admittedExecutables.set(payload.executionId, resolved.path);
    return { ok: true };
  }

  hasActiveSession(executionId: string): boolean {
    const session = this.sessions.get(executionId);
    return Boolean(session && !session.finished && !session.cancelled);
  }

  start(payload: ExecutionStartMessage['payload'], context: RepositoryContext): void {
    const admittedExecutable = this.admittedExecutables.get(payload.executionId) ?? null;
    this.admittedExecutables.delete(payload.executionId);
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
    session.executablePath = admittedExecutable;
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
    this.admittedExecutables.delete(executionId);
    const session = this.sessions.get(executionId);
    if (!session || session.finished || session.cancelled || session.journalAborted) {
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
    const uncertain = [...this.uncertainOrphans];
    if (initial.length === 0) {
      return {
        clean: uncertain.length === 0,
        remainingExecutionIds: uncertain,
        forced: uncertain.length > 0,
      };
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

    const remainingUncertain = [...this.uncertainOrphans];
    return {
      clean: clean && remainingUncertain.length === 0,
      remainingExecutionIds: [...this.sessions.keys(), ...remainingUncertain],
      forced: forced || remainingUncertain.length > 0,
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
    this.assertJournalUsable(session);

    const worktree = await this.git.prepare(
      session.projectPath,
      payload.projectId,
      payload.executionId,
      { baseCommit: context.baseCommit },
    );
    this.assertJournalUsable(session);
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

    if (session.cancelled || session.finished) {
      await this.finalize(session, 'cancelled', {
        reason: session.cancelReason ?? 'Cancelled by operator',
        exitCode: null,
        summary: null,
      });
      return;
    }

    const command = this.config.cliPaths[payload.runtime] ?? payload.runtime;
    let executable = session.executablePath;
    if (!executable) {
      // Defense in depth only. Normal admission resolved this before accepted;
      // a miss here is a last-moment race, not the ordinary CLI-missing path.
      const resolved = await this.resolveExecutable(command);
      executable = resolved.path;
      if (!executable) {
        throw new RunnerFailure(
          'CLI_NOT_INSTALLED',
          resolved.error ?? `${payload.runtime} CLI was not found`,
        );
      }
    }
    this.assertJournalUsable(session);
    if (session.cancelled || session.finished) {
      await this.finalize(session, 'cancelled', {
        reason: session.cancelReason ?? 'Cancelled by operator',
        exitCode: null,
        summary: null,
      });
      return;
    }

    const args = buildCliArgs(payload.runtime, payload, worktree.path, this.config);
    this.log(
      session,
      'system',
      'info',
      `Starting the ${payload.runtime} CLI in the isolated worktree.`,
    );
    this.assertJournalUsable(session);

    let child: ChildProcess;
    try {
      child = this.spawnProcess(executable, args, {
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
    session.identityPending = true;
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

    try {
      // The PID and its start marker must be durable before the execution is
      // reported as running. If either cannot be persisted, the child is
      // terminated and the failure is reported, never treated as a normal run.
      await this.recordSpawnedProcessIdentity(session, child);
    } catch (error) {
      session.identityPending = false;
      await this.abortSpawnedProcess(session, child, this.describeError(error));
      return;
    }
    if (session.finished) return;

    try {
      await this.persistPhase(session, 'running', 'CLI process started');
    } catch (error) {
      await this.abortSpawnedProcess(
        session,
        child,
        `RECOVERY_JOURNAL_WRITE_FAILED: ${errorMessage(error)}`,
      );
      return;
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
    if (session.finished || session.journalAborted) return;
    session.exitCode = code;
    session.signal = signal;
    if (session.identityPending) {
      // Never decide a terminal outcome before the PID identity is durable;
      // otherwise a fast exit could hide a failed identity write.
      session.pendingExit = { code, signal };
      return;
    }

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
    session.identityPending = false;
    session.pendingExit = null;
    this.clearTimers(session);

    for (const line of session.parser.flush()) {
      this.writeParsed(session, line);
    }

    if (outcome === 'completed') {
      this.emitPhase(session, 'finalizing', 'Collecting the Git result');
    }

    let git: GitExecutionResult | null = null;
    let gitError: string | null = null;
    try {
      git = await this.collectGit(session);
    } catch (error) {
      gitError = errorMessage(error);
    }

    let finalOutcome: 'completed' | 'failed' | 'cancelled' = outcome;
    let finalResult = result;
    if (gitError) {
      finalOutcome = 'failed';
      const originalReason = result.reason?.trim() || `original outcome: ${outcome}`;
      finalResult = {
        reason: `GIT_COLLECT_FAILED: ${gitError}; ${originalReason}`.slice(0, 2000),
        exitCode: result.exitCode ?? session.exitCode,
        summary: result.summary ?? session.parser.lastSummary(),
      };
    }

    // A completed/cancelled execution is only reported after its terminal
    // journal record is durable. If the journal cannot be finalized, surface a
    // failure instead of reporting a success the recovery scan cannot confirm.
    try {
      await this.finishJournal(session, finalOutcome);
    } catch (error) {
      const journalFinishError = errorMessage(error);
      finalOutcome = 'failed';
      const originalReason = finalResult.reason?.trim() || `original outcome: ${outcome}`;
      finalResult = {
        reason: `RECOVERY_JOURNAL_FINISH_FAILED: ${journalFinishError}; ${originalReason}`.slice(
          0,
          2000,
        ),
        exitCode: finalResult.exitCode ?? session.exitCode,
        summary: finalResult.summary ?? session.parser.lastSummary(),
      };
    }

    session.phase = finalOutcome;

    if (finalOutcome === 'completed') {
      const summary =
        finalResult.summary?.trim() ||
        session.parser.lastSummary() ||
        `${session.runtime} CLI completed without a final summary.`;
      this.log(session, 'system', 'success', 'CLI process exited successfully.');
      this.emitProgress(session, 100, 0, 'determinate');
      const payload: CompletedPayload = {
        exitCode: finalResult.exitCode ?? 0,
        summary: summary.slice(0, 20_000),
        git,
      };
      this.callbacks.onCompleted(session, payload);
    } else if (finalOutcome === 'failed') {
      const reason = (finalResult.reason ?? 'CLI execution failed').slice(0, 2000);
      this.log(session, 'stderr', 'error', reason);
      const payload: FailedPayload = {
        reason,
        exitCode: finalResult.exitCode ?? null,
        summary: finalResult.summary ?? session.parser.lastSummary(),
        git,
      };
      this.callbacks.onFailed(session, payload);
    } else {
      const reason = finalResult.reason?.trim() || 'Cancelled by operator';
      this.log(
        session,
        'system',
        'warning',
        `CLI process stopped; cancellation confirmed: ${reason}`,
      );
      const payload: CancelledPayload = {
        reason,
        exitCode: finalResult.exitCode ?? null,
        git,
      };
      this.callbacks.onCancelled(session, payload);
    }

    this.sessions.delete(session.executionId);
    this.admittedExecutables.delete(session.executionId);
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
    if (persistJournal && session.journalStarted && !session.journalAborted) {
      void this.persistJournal(session, { phase, status: 'active' }, true).catch(
        (error: unknown) => {
          this.handleJournalFailure(session, error);
        },
      );
    }
    this.callbacks.onPhase(session, phase, message);
  }

  /**
   * Persists a phase before notifying the protocol layer. Used for the
   * transition to `running` so a successful callback never claims progress that
   * the recovery journal cannot confirm.
   */
  private async persistPhase(
    session: RealSession,
    phase: ExecutionPhase,
    message: string | null,
  ): Promise<void> {
    session.phase = phase;
    await this.persistJournal(session, { phase, status: 'active' }, true);
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
    if (persistJournal && session.journalStarted && !session.journalAborted) {
      void this.persistJournal(
        session,
        { lastSequence: session.lastSeq, phase: session.phase, status: 'active' },
        false,
      ).catch((error: unknown) => {
        this.handleJournalFailure(session, error);
      });
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
      executablePath: null,
      timeoutTimer: null,
      forceKillTimer: null,
      fallbackTimer: null,
      sawOutput: false,
      exitCode: null,
      signal: null,
      processStartTime: null,
      processGroupId: null,
      journalStarted: false,
      journalAborted: false,
      journalError: null,
      identityPending: false,
      pendingExit: null,
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
    if (!this.recovery) {
      throw new RunnerFailure(
        'RECOVERY_JOURNAL_NOT_CONFIGURED',
        'The runner has no recovery journal; refusing to spawn without crash evidence',
      );
    }
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
      session.journalStarted = true;
    } catch (error) {
      throw new RunnerFailure(
        'RECOVERY_JOURNAL_WRITE_FAILED',
        `Could not persist the recovery journal before spawning: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Persists the spawned child's PID and OS identity. Throws when any part of
   * the identity cannot be captured or written; callers must terminate the
   * child instead of continuing.
   */
  private async recordSpawnedProcessIdentity(
    session: RealSession,
    child: ChildProcess,
  ): Promise<void> {
    const pid = child.pid ?? null;
    if (!pid) {
      throw new RunnerFailure(
        'RECOVERY_JOURNAL_PID_MISSING',
        'The spawned CLI did not expose a PID; recovery identity cannot be recorded',
      );
    }

    let identity: ProcessIdentity | null;
    try {
      identity = await this.inspectProcess(pid);
    } catch (error) {
      throw new RunnerFailure(
        'RECOVERY_JOURNAL_PID_IDENTITY_FAILED',
        `Could not inspect PID ${pid}: ${errorMessage(error)}`,
      );
    }
    if (session.finished) return;
    if (!identity) {
      throw new RunnerFailure(
        'RECOVERY_JOURNAL_PID_IDENTITY_FAILED',
        `PID ${pid} has no verifiable start marker; recovery identity cannot be recorded`,
      );
    }

    session.processStartTime = identity.startTime;
    session.processGroupId = identity.processGroupId ?? pid;

    try {
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
    } catch (error) {
      throw new RunnerFailure(
        'RECOVERY_JOURNAL_PID_WRITE_FAILED',
        `Could not persist PID ${pid} and its start marker: ${errorMessage(error)}`,
      );
    }

    session.identityPending = false;
    const pendingExit = session.pendingExit;
    session.pendingExit = null;
    if (pendingExit) {
      // The CLI exited during the identity write. Decide its real outcome now
      // that the durable identity is in place.
      await this.finishFromClose(session, pendingExit.code, pendingExit.signal);
    }
  }

  private persistJournal(
    session: RealSession,
    patch: ExecutionJournalPatch,
    immediate: boolean,
  ): Promise<void> {
    if (!this.recovery || !session.journalStarted || session.finished) {
      return Promise.resolve();
    }
    return this.recovery.journal.update(session.executionId, patch, { immediate });
  }

  private async finishJournal(
    session: RealSession,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    if (!this.recovery || !session.journalStarted) return;
    await this.recovery.journal.finish(session.executionId, outcome, outcome, session.lastSeq);
  }

  private assertJournalUsable(session: RealSession): void {
    if (session.journalError) {
      throw new RunnerFailure('RECOVERY_JOURNAL_WRITE_FAILED', session.journalError);
    }
    if (!session.journalStarted) {
      throw new RunnerFailure(
        'RECOVERY_JOURNAL_NOT_CONFIGURED',
        'The recovery journal was not started; refusing to continue',
      );
    }
  }

  /**
   * Latches a journal failure and, once a child exists, terminates it. A
   * prepare-phase failure is observed by the next `assertJournalUsable`
   * checkpoint; a running failure is aborted immediately.
   */
  private handleJournalFailure(session: RealSession, error: unknown): void {
    const detail = errorMessage(error);
    if (!session.journalError) session.journalError = detail;
    this.log(session, 'system', 'error', `Recovery journal update failed: ${detail}`, false);
    if (session.finished || session.journalAborted) return;
    const child = session.child;
    if (!child) return;
    void this.abortSpawnedProcess(session, child, `RECOVERY_JOURNAL_WRITE_FAILED: ${detail}`).catch(
      (abortError: unknown) => {
        this.finalizeUnconfirmed(
          session,
          `RECOVERY_JOURNAL_WRITE_FAILED: ${detail}; terminating the CLI failed: ${errorMessage(
            abortError,
          )}`,
        );
      },
    );
  }

  /**
   * Terminates a child whose recovery identity could not be made durable and
   * verifies the exit. If the exit cannot be confirmed, the journal is left
   * active and the execution is reported as an uncertain failure.
   */
  private async abortSpawnedProcess(
    session: RealSession,
    child: ChildProcess,
    reason: string,
  ): Promise<void> {
    if (session.finished || session.journalAborted) return;
    session.journalAborted = true;
    session.identityPending = false;
    this.clearTimers(session);

    const pid = child.pid ?? null;
    let terminationError: string | null = null;
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    let exited = alreadyExited;

    if (!exited) {
      try {
        await this.terminateProcess(child, true);
      } catch (error) {
        terminationError = errorMessage(error);
      }
    }
    if (!exited && pid) {
      try {
        exited = await this.waitForProcessExit(pid, JOURNAL_ABORT_CONFIRM_MS);
      } catch (error) {
        terminationError = terminationError ?? errorMessage(error);
        exited = false;
      }
    }
    // The child close event is also authoritative: Node observed the process
    // exit even if the PID disappeared from the OS table before the next poll.
    if (!exited) {
      exited = child.exitCode !== null || child.signalCode !== null;
    }

    if (exited) {
      const confirmed = `${reason}; ${
        alreadyExited
          ? 'the CLI process had already exited'
          : 'the CLI process tree was terminated and its exit was confirmed'
      }`;
      this.log(session, 'stderr', 'error', confirmed, false);
      await this.finalize(session, 'failed', {
        reason: confirmed,
        exitCode: session.exitCode ?? child.exitCode,
        summary: session.parser.lastSummary(),
      });
      return;
    }

    const uncertain = `${reason}; the CLI process tree could not be confirmed terminated${
      pid ? ` (PID ${pid})` : ''
    }${terminationError ? `: ${terminationError}` : ''}; the recovery journal was left active for manual recovery`.slice(
      0,
      2000,
    );
    this.log(session, 'stderr', 'error', uncertain, false);

    // Last durable attempt to keep the PID as evidence. This deliberately does
    // not finalize the journal: a later startup scan must still see an active
    // record and retry the verified termination.
    if (pid && session.journalStarted) {
      try {
        await this.persistJournal(
          session,
          {
            pid,
            processStartTime: session.processStartTime,
            processGroupId: session.processGroupId,
            phase: 'failed',
          },
          true,
        );
      } catch (error) {
        session.journalError = session.journalError ?? errorMessage(error);
      }
    }

    this.finalizeUnconfirmed(session, uncertain);
  }

  /**
   * Reports a failed terminal event without pretending the journal was
   * finalized. The active journal record and worktree remain as evidence.
   */
  private finalizeUnconfirmed(session: RealSession, reason: string): void {
    if (session.finished) return;
    session.finished = true;
    session.identityPending = false;
    session.pendingExit = null;
    this.clearTimers(session);
    session.phase = 'failed';
    this.uncertainOrphans.add(session.executionId);
    this.callbacks.onFailed(session, {
      reason: reason.slice(0, 2000),
      exitCode: session.exitCode,
      summary: session.parser.lastSummary(),
      git: null,
    });
    this.sessions.delete(session.executionId);
    this.admittedExecutables.delete(session.executionId);
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
