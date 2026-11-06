import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ExecutionStatus, LogLevel, RuntimeControlMode } from '@raft-lite/contracts';
import { AppLogger } from '../../common/logger/app-logger';
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeStatus,
} from './agent-runtime.interface';

interface MockSession {
  context: RuntimeContext;
  status: ExecutionStatus;
  progress: number;
  step: number;
  seq: number;
  timer: NodeJS.Timeout | null;
}

interface MockStep {
  progress: number;
  level: LogLevel;
  message: string;
}

const STEPS: readonly MockStep[] = [
  {
    progress: 20,
    level: 'info',
    message: 'Received task context and loaded workspace conventions.',
  },
  {
    progress: 40,
    level: 'info',
    message: 'Outlined an execution plan and identified affected modules.',
  },
  {
    progress: 60,
    level: 'info',
    message: 'Applied implementation changes in the task workspace.',
  },
  {
    progress: 80,
    level: 'info',
    message: 'Ran validation checks and reviewed the resulting diff.',
  },
  {
    progress: 100,
    level: 'success',
    message: 'Execution completed successfully. Summary prepared for review.',
  },
];

@Injectable()
export class MockRuntimeService implements AgentRuntime, OnModuleDestroy {
  readonly type = 'mock';
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly sessions = new Map<string, MockSession>();
  private mode: RuntimeControlMode = 'auto';
  private readonly tickMs = Math.max(40, Number(process.env.MOCK_TICK_MS ?? 650));

  constructor(private readonly logger: AppLogger) {}

  async start(context: RuntimeContext): Promise<void> {
    if (this.sessions.has(context.executionId)) {
      throw new Error(`Execution ${context.executionId} already exists in the mock runtime`);
    }

    const session: MockSession = {
      context,
      status: 'running',
      progress: 0,
      step: 0,
      seq: 1,
      timer: null,
    };
    this.sessions.set(context.executionId, session);
    this.emit({
      type: 'log',
      executionId: context.executionId,
      level: 'info',
      message: 'Mock runtime attached; execution accepted.',
      seq: session.seq,
    });
    this.emit({ type: 'progress', executionId: context.executionId, progress: 0, step: 0 });
    this.logger.info({
      eventType: 'runtime.started',
      message: 'Mock runtime session started',
      executionId: context.executionId,
      taskId: context.taskId,
      agentId: context.agentId,
      status: 'running',
    });

    if (this.mode === 'auto') {
      this.schedule(session);
    }
  }

  async stop(executionId: string): Promise<void> {
    const session = this.sessions.get(executionId);
    if (!session) {
      return;
    }
    this.clearTimer(session);
    session.status = 'cancelled';
    this.sessions.delete(executionId);
    this.logger.info({
      eventType: 'runtime.stopped',
      message: 'Mock runtime session stopped',
      executionId,
      taskId: session.context.taskId,
      agentId: session.context.agentId,
      status: 'cancelled',
    });
  }

  async getStatus(executionId: string): Promise<RuntimeStatus | null> {
    const session = this.sessions.get(executionId);
    if (!session) {
      return null;
    }
    return {
      executionId,
      status: session.status,
      progress: session.progress,
      step: session.step,
    };
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMode(mode: RuntimeControlMode): void {
    this.mode = mode;
  }

  getMode(): RuntimeControlMode {
    return this.mode;
  }

  /** Test-only deterministic stepping. Returns null when the session is absent. */
  advance(
    executionId: string,
    steps = 1,
  ): { step: number; progress: number; completed: boolean } | null {
    const session = this.sessions.get(executionId);
    if (!session || session.status !== 'running') {
      return null;
    }
    for (let index = 0; index < steps; index += 1) {
      this.runStep(session);
      if (session.status !== 'running') {
        break;
      }
    }
    return {
      step: session.step,
      progress: session.progress,
      completed: session.step >= STEPS.length,
    };
  }

  /** Test-only deterministic outcome. */
  finish(executionId: string, outcome: 'success' | 'failure', reason?: string): boolean {
    const session = this.sessions.get(executionId);
    if (!session || session.status !== 'running') {
      return false;
    }
    this.clearTimer(session);
    if (outcome === 'success') {
      session.progress = 100;
      session.step = STEPS.length;
      session.seq += 1;
      this.emit({
        type: 'log',
        executionId,
        level: 'success',
        message: 'Execution completed successfully through deterministic runtime control.',
        seq: session.seq,
      });
      this.emit({ type: 'progress', executionId, progress: 100, step: session.step });
      session.status = 'completed';
      this.emit({ type: 'completed', executionId });
    } else {
      const failureReason = reason ?? 'Deterministic mock failure requested by the test harness';
      session.seq += 1;
      this.emit({
        type: 'log',
        executionId,
        level: 'error',
        message: `Execution failed: ${failureReason}`,
        seq: session.seq,
      });
      session.status = 'failed';
      this.emit({ type: 'failed', executionId, reason: failureReason });
    }
    this.sessions.delete(executionId);
    return true;
  }

  reset(): void {
    for (const session of this.sessions.values()) {
      this.clearTimer(session);
    }
    this.sessions.clear();
    this.mode = 'auto';
  }

  onModuleDestroy(): void {
    this.reset();
  }

  private schedule(session: MockSession): void {
    this.clearTimer(session);
    session.timer = setTimeout(() => {
      if (session.status !== 'running') {
        return;
      }
      this.runStep(session);
      if (session.status === 'running') {
        this.schedule(session);
      }
    }, this.tickMs);
    session.timer.unref();
  }

  private runStep(session: MockSession): void {
    const nextStep = STEPS[session.step];
    if (!nextStep) {
      return;
    }
    session.step += 1;
    session.progress = nextStep.progress;
    session.seq += 1;
    this.emit({
      type: 'log',
      executionId: session.context.executionId,
      level: nextStep.level,
      message: nextStep.message,
      seq: session.seq,
    });
    this.emit({
      type: 'progress',
      executionId: session.context.executionId,
      progress: nextStep.progress,
      step: session.step,
    });

    if (session.step >= STEPS.length) {
      this.clearTimer(session);
      session.status = 'completed';
      this.emit({ type: 'completed', executionId: session.context.executionId });
      this.sessions.delete(session.context.executionId);
    }
  }

  private clearTimer(session: MockSession): void {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
