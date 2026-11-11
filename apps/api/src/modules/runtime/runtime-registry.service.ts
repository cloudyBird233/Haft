import { HttpStatus, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type {
  AgentRuntimeType,
  RuntimeAvailabilityDto,
} from '@raft-lite/contracts';
import { RUNTIME_LABELS, RUNNER_RUNTIMES, type RunnerFeature } from '@raft-lite/contracts';
import { AppException } from '../../common/errors/app.exception';
import { AppLogger } from '../../common/logger/app-logger';
import { RepositoryHandshakeService } from '../runners/repository-handshake.service';
import { RunnerRegistryService, type LiveRunnerRegistration } from '../runners/runner-registry.service';
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeEventListener,
  RuntimeStatus,
} from './agent-runtime.interface';
import { MockRuntimeService } from './mock-runtime.service';
import { RunnerRuntimeService } from './runner-runtime.service';

/**
 * Features a live runner must advertise for any real execution dispatch.
 * A partial advertisement is unsupported; validation-only WP-A runners must
 * not receive an execution handshake.
 */
const EXECUTION_REQUIRED_FEATURES: readonly RunnerFeature[] = [
  'project-binding-v1',
  'repository-handshake-v1',
  'repository-path-policy-v1',
];

/**
 * Single selection point for runtime implementations. ExecutionsService asks
 * the registry; it never branches on runtime names.
 */
@Injectable()
export class RuntimeRegistryService implements OnModuleDestroy {
  private readonly runtimes = new Map<AgentRuntimeType, AgentRuntime>();
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly mock: MockRuntimeService,
    private readonly runners: RunnerRegistryService,
    private readonly handshake: RepositoryHandshakeService,
    private readonly logger: AppLogger,
  ) {
    this.register(mock);
    this.register(new RunnerRuntimeService('codex', runners, handshake));
    this.register(new RunnerRuntimeService('opencode', runners, handshake));

    // Runner-backed executions are all emitted by one shared source.
    this.unsubscribers.push(
      this.runners.onExecutionEvent((event) => {
        for (const listener of [...this.listeners]) {
          listener(event);
        }
      }),
    );
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers.length = 0;
    this.listeners.clear();
  }

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.type as AgentRuntimeType, runtime);
    if (runtime.type === 'mock') {
      this.unsubscribers.push(
        runtime.onEvent((event) => {
          for (const listener of [...this.listeners]) {
            listener(event);
          }
        }),
      );
    }
  }

  get(type: AgentRuntimeType): AgentRuntime | null {
    return this.runtimes.get(type) ?? null;
  }

  require(type: AgentRuntimeType): AgentRuntime {
    const runtime = this.get(type);
    if (!runtime) {
      throw new AppException(
        'RUNTIME_NOT_AVAILABLE',
        `${RUNTIME_LABELS[type]} is not registered`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return runtime;
  }

  list(): AgentRuntimeType[] {
    return [...this.runtimes.keys()];
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(type: AgentRuntimeType, context: RuntimeContext): Promise<void> {
    await this.require(type).start(context);
  }

  async stop(type: AgentRuntimeType, executionId: string): Promise<void> {
    await this.require(type).stop(executionId);
  }

  async getStatus(type: AgentRuntimeType, executionId: string): Promise<RuntimeStatus | null> {
    return this.require(type).getStatus(executionId);
  }

  acknowledgeLog(runnerId: string, executionId: string, throughSeq: number): void {
    this.runners.sendLogAck(runnerId, executionId, throughSeq);
  }

  cancelOnRunner(runnerId: string, executionId: string, reason?: string): boolean {
    return this.runners.dispatchCancel(runnerId, executionId, reason);
  }

  getLiveRunnerRegistration(runnerId: string): LiveRunnerRegistration | null {
    return this.runners.getLiveRegistration(runnerId);
  }

  noteFinished(type: AgentRuntimeType, executionId: string): void {
    const runtime = this.runtimes.get(type);
    if (runtime && 'markFinished' in runtime) {
      (runtime as AgentRuntime & { markFinished: (id: string) => void }).markFinished(executionId);
    }
  }

  async availability(
    computerId: string | null,
    _projectId: string | null,
  ): Promise<RuntimeAvailabilityDto[]> {
    const result: RuntimeAvailabilityDto[] = [
      {
        runtime: 'mock',
        label: RUNTIME_LABELS.mock,
        available: true,
        requiresRunner: false,
        reason: null,
        reasonCode: null,
        runnerId: null,
        runnerStatus: null,
        cliVersion: null,
        authenticated: null,
        projectIds: [],
      },
    ];

    const runner = computerId ? await this.runners.findByComputer(computerId) : null;
    for (const runtime of RUNNER_RUNTIMES) {
      const capability = runner?.capabilities.runtimes.find((item) => item.runtime === runtime);
      const connected = runner ? this.runners.isConnected(runner.id) : false;
      let reason: string | null = null;
      let reasonCode: string | null = null;
      if (!computerId) {
        reason = 'Assign the agent to a computer first';
        reasonCode = 'COMPUTER_NOT_ASSIGNED';
      } else if (!runner) {
        reason = 'No runner is registered for this computer';
        reasonCode = 'RUNNER_NOT_REGISTERED';
      } else if (!connected) {
        reason = 'The runner is offline';
        reasonCode = 'RUNNER_OFFLINE';
      } else if (!capability?.installed) {
        reason = `${RUNTIME_LABELS[runtime]} is not installed on the runner`;
        reasonCode = 'CLI_NOT_INSTALLED';
      } else if (!capability.authenticated) {
        reason = capability.message ?? `${RUNTIME_LABELS[runtime]} is not authenticated`;
        reasonCode = 'CLI_NOT_AUTHENTICATED';
      } else if (!this.runners.hasLiveFeatures(runner.id, EXECUTION_REQUIRED_FEATURES)) {
        reason =
          'The runner does not support the P2-02 execution repository handshake; upgrade it';
        reasonCode = 'PROJECT_BINDING_UNSUPPORTED';
      }

      result.push({
        runtime,
        label: RUNTIME_LABELS[runtime],
        available: reason === null,
        requiresRunner: true,
        reason,
        reasonCode,
        runnerId: runner?.id ?? null,
        runnerStatus: runner?.status ?? null,
        cliVersion: capability?.version ?? null,
        authenticated: capability?.authenticated ?? null,
        projectIds: runner?.capabilities.projectIds ?? [],
      });
    }
    return result;
  }

  async getAvailability(
    runtime: AgentRuntimeType,
    computerId: string | null,
    projectId: string | null,
  ): Promise<RuntimeAvailabilityDto> {
    const all = await this.availability(computerId, projectId);
    const match = all.find((item) => item.runtime === runtime);
    if (!match) {
      this.logger.warn({
        eventType: 'runtime.unknown',
        message: `No availability descriptor for runtime ${runtime}`,
        status: 'warning',
      });
      return {
        runtime,
        label: RUNTIME_LABELS[runtime],
        available: false,
        requiresRunner: runtime !== 'mock',
        reason: 'Unknown runtime',
        reasonCode: 'RUNTIME_UNKNOWN',
        runnerId: null,
        runnerStatus: null,
        cliVersion: null,
        authenticated: null,
        projectIds: [],
      };
    }
    return match;
  }
}
