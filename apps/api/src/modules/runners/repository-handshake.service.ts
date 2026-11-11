import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  ERROR_CODES,
  type ExecutionRepositoryAcceptedPayload,
  type ExecutionRepositoryPayload,
  type RunnerEnvelope,
  type RunnerFeature,
} from '@raft-lite/contracts';
import { AppLogger } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RepositoryDispatchError } from './repository-errors';
import { sameRepositoryPath } from './repository-state';
import {
  RunnerRegistryService,
  type ExecutionAcceptedPayload,
  type ExecutionStartDispatchPayload,
  type RunnerProtocolEvent,
} from './runner-registry.service';

export interface RepositoryDispatchInput extends ExecutionStartDispatchPayload {
  runnerId: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ExecutionSnapshot {
  id: string;
  status: string;
  dispatchState: string;
  runnerId: string | null;
  computerId: string;
  projectId: string;
  bindingId: string;
  bindingVersion: number;
  defaultBranch: string;
}

interface PendingDispatch {
  key: string;
  executionId: string;
  runnerId: string;
  snapshot: ExecutionSnapshot;
  expectedPolicyVersion: string;
  expectedCanonicalPath: string;
  repositoryMessage: RunnerEnvelope;
  repositoryDeferred: Deferred<ExecutionRepositoryAcceptedPayload>;
  startDeferred: Deferred<ExecutionAcceptedPayload>;
  startMessage: RunnerEnvelope | null;
  retryTimers: NodeJS.Timeout[];
  timeoutTimer: NodeJS.Timeout | null;
  startTimer: NodeJS.Timeout | null;
  settled: boolean;
}

const REPOSITORY_RETRY_DELAYS_MS = [2_000, 6_000] as const;
const REPOSITORY_HANDSHAKE_TIMEOUT_MS = 15_000;
const START_ACCEPT_TIMEOUT_MS = 20_000;

const REQUIRED_EXECUTION_FEATURES: readonly RunnerFeature[] = [
  'project-binding-v1',
  'repository-handshake-v1',
  'repository-path-policy-v1',
];

/**
 * Owns the `execution.repository -> accepted -> execution.start -> accepted`
 * state machine.
 *
 * It never writes the synchronous terminal failure state. A failed handshake
 * throws `RepositoryDispatchError`; `ExecutionsService.failExecutionStart` is
 * the single writer that also restores the Task/Agent status exactly once.
 */
@Injectable()
export class RepositoryHandshakeService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingDispatch>();
  private unsubscribeProtocol: (() => void) | null = null;
  private unsubscribeRegistration: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runners: RunnerRegistryService,
    private readonly logger: AppLogger,
  ) {
    this.unsubscribeProtocol = this.runners.onProtocolEvent((event) => this.onProtocolEvent(event));
    // WP-D resumes persisted pre-start rows on register. WP-C records the hook
    // so live feature/platform changes are observable without changing state.
    this.unsubscribeRegistration = this.runners.onRunnerRegistered((event) => {
      this.logger.info({
        eventType: 'repository.runner_registered',
        message: 'Runner registered with live repository features',
        runnerId: event.runnerId,
        status: 'online',
      });
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeProtocol?.();
    this.unsubscribeRegistration?.();
    this.unsubscribeProtocol = null;
    this.unsubscribeRegistration = null;
    for (const pending of this.pending.values()) {
      this.rejectPending(
        pending,
        new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
          'The API is shutting down during the repository handshake',
        ),
      );
    }
    this.pending.clear();
  }

  /**
   * Kills a pending handshake when another path has already made the execution
   * terminal. Called by ExecutionsService.finishExecution/cancel; a no-op when
   * no handshake is in flight.
   */
  noteTerminal(executionId: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.executionId !== executionId) continue;
      this.rejectPending(
        pending,
        new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
          'The execution reached a terminal state during the repository handshake',
        ),
      );
      this.pending.delete(key);
    }
  }

  async dispatch(input: RepositoryDispatchInput): Promise<void> {
    const snapshot = await this.loadSnapshot(input);
    await this.assertDispatchable(snapshot);
    await this.assertCapacity(input.runnerId, input.executionId);

    const acquired = await this.prisma.execution.updateMany({
      where: { id: input.executionId, dispatchState: 'created' },
      data: { dispatchState: 'repository_preparing' },
    });
    if (acquired.count === 0) {
      const current = await this.prisma.execution.findUnique({
        where: { id: input.executionId },
        select: { status: true, dispatchState: true },
      });
      if (!current || current.status !== 'running') {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
          'The execution is no longer running',
        );
      }
      this.logger.warn({
        eventType: 'repository.dispatch_duplicate',
        message: 'Execution dispatch was acquired by another dispatcher',
        runnerId: input.runnerId,
        executionId: input.executionId,
        status: 'warning',
        dispatchState: current.dispatchState,
      });
      throw new RepositoryDispatchError(
        ERROR_CODES.EXECUTION_ALREADY_RUNNING,
        'This execution is already being dispatched',
      );
    }
    await this.audit(input.executionId, 'repository_preparing', {
      bindingVersion: snapshot.bindingVersion,
    });

    const binding = await this.prisma.projectRepositoryBinding.findUnique({
      where: { id: snapshot.bindingId },
      select: { path: true, canonicalPath: true, policyVersion: true },
    });
    if (!binding?.canonicalPath || !binding.policyVersion) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The repository binding is not ready for execution',
      );
    }

    const payload: ExecutionRepositoryPayload = {
      executionId: input.executionId,
      projectId: snapshot.projectId,
      bindingId: snapshot.bindingId,
      bindingVersion: snapshot.bindingVersion,
      path: binding.path,
      defaultBranch: snapshot.defaultBranch,
      policyVersion: binding.policyVersion,
    };
    const repositoryMessage = this.runners.buildEnvelope(
      input.runnerId,
      'execution.repository',
      payload,
      randomUUID(),
    );

    const pending = this.createPending(
      input,
      snapshot,
      repositoryMessage,
      binding.canonicalPath,
      binding.policyVersion,
    );
    this.pending.set(pending.key, pending);

    try {
      this.armRepositoryTimers(pending);
      if (!this.runners.sendEnvelope(input.runnerId, repositoryMessage)) {
        throw new RepositoryDispatchError(
          ERROR_CODES.RUNNER_OFFLINE,
          'The assigned runner disconnected before the repository handshake',
          true,
        );
      }

      const accepted = await pending.repositoryDeferred.promise;
      this.clearRepositoryTimers(pending);
      await this.acceptedRepository(pending, accepted);

      const startMessage = this.runners.buildEnvelope(input.runnerId, 'execution.start', {
        executionId: input.executionId,
        runtime: input.runtime,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        taskDescription: input.taskDescription,
        projectId: input.projectId,
        prompt: input.prompt,
        options: input.options ?? {},
      });
      pending.startMessage = startMessage;
      pending.startTimer = setTimeout(() => {
        pending.startDeferred.reject(
          new RepositoryDispatchError(
            ERROR_CODES.START_ACCEPT_TIMEOUT,
            'The runner did not confirm that the CLI started in time',
            true,
          ),
        );
      }, START_ACCEPT_TIMEOUT_MS);
      pending.startTimer.unref();

      if (!this.runners.sendEnvelope(input.runnerId, startMessage)) {
        throw new RepositoryDispatchError(
          ERROR_CODES.RUNNER_OFFLINE,
          'The assigned runner disconnected before execution.start',
          true,
        );
      }
      await pending.startDeferred.promise;
      pending.settled = true;
      await this.audit(input.executionId, 'running', {
        bindingVersion: snapshot.bindingVersion,
        policyVersion: binding.policyVersion,
      });
    } catch (error) {
      if (error instanceof RepositoryDispatchError) {
        if (error.code === ERROR_CODES.REPOSITORY_POLICY_CHANGED) {
          await this.markBindingUnverified(snapshot.bindingId, snapshot.bindingVersion);
        }
        await this.audit(input.executionId, 'handshake_failed', {
          bindingVersion: snapshot.bindingVersion,
          code: error.code,
          message: error.message,
        });
      }
      this.runners.dispatchCancel(
        input.runnerId,
        input.executionId,
        `${errorCode(error)}: handshake failed`,
      );
      throw error;
    } finally {
      this.clearPending(pending);
    }
  }

  private async loadSnapshot(input: RepositoryDispatchInput): Promise<ExecutionSnapshot> {
    const execution = await this.prisma.execution.findUnique({
      where: { id: input.executionId },
      include: { runner: { select: { computerId: true } } },
    });
    if (!execution) {
      throw new RepositoryDispatchError(
        ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
        'The execution no longer exists',
      );
    }
    if (execution.runnerId !== input.runnerId) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The execution is not owned by the selected runner',
      );
    }
    if (
      !execution.repositoryProjectId ||
      !execution.repositoryBindingId ||
      !execution.repositoryBindingVersion ||
      !execution.repositoryDefaultBranch ||
      !execution.runner
    ) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The execution has no repository binding snapshot',
      );
    }
    return {
      id: execution.id,
      status: execution.status,
      dispatchState: execution.dispatchState,
      runnerId: execution.runnerId,
      computerId: execution.runner.computerId,
      projectId: execution.repositoryProjectId,
      bindingId: execution.repositoryBindingId,
      bindingVersion: execution.repositoryBindingVersion,
      defaultBranch: execution.repositoryDefaultBranch,
    };
  }

  private async assertDispatchable(snapshot: ExecutionSnapshot): Promise<void> {
    if (snapshot.status !== 'running') {
      throw new RepositoryDispatchError(
        ERROR_CODES.REPOSITORY_CONTEXT_NOT_READY,
        'The execution is not running',
      );
    }
    if (snapshot.dispatchState !== 'created') {
      throw new RepositoryDispatchError(
        ERROR_CODES.EXECUTION_ALREADY_RUNNING,
        'This execution is already being dispatched',
      );
    }

    const live = this.runners.getLiveRegistration(snapshot.runnerId ?? '');
    if (!live || !this.runners.isConnected(snapshot.runnerId ?? '')) {
      throw new RepositoryDispatchError(
        ERROR_CODES.RUNNER_OFFLINE,
        'The assigned runner is not connected',
        true,
      );
    }
    if (live.computerId !== snapshot.computerId) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The selected runner no longer belongs to this computer',
      );
    }
    if (!REQUIRED_EXECUTION_FEATURES.every((feature) => live.features.includes(feature))) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_UNSUPPORTED,
        'The runner does not advertise the repository handshake features',
      );
    }

    const binding = await this.prisma.projectRepositoryBinding.findUnique({
      where: { id: snapshot.bindingId },
    });
    if (!binding) {
      throw new RepositoryDispatchError(
        ERROR_CODES.REPOSITORY_BINDING_CHANGED,
        'The repository binding was removed during execution creation',
      );
    }
    this.assertBindingIdentity(binding, snapshot.runnerId, live.platform);
    if (
      binding.status !== 'ready' ||
      binding.validatedBindingVersion !== binding.bindingVersion ||
      binding.bindingVersion !== snapshot.bindingVersion
    ) {
      throw new RepositoryDispatchError(
        ERROR_CODES.REPOSITORY_BINDING_CHANGED,
        'The repository binding is no longer ready at the snapshot version',
      );
    }
    if (!binding.canonicalPath || !binding.policyVersion) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The repository binding has no validated canonical path or policy version',
      );
    }
  }

  private assertBindingIdentity(
    binding: {
      id: string;
      platform: string | null;
      validatedByRunnerId: string | null;
      status: string;
    },
    runnerId: string | null,
    runnerPlatform: string,
  ): void {
    if (
      binding.status !== 'ready' ||
      !binding.validatedByRunnerId ||
      !runnerId ||
      binding.validatedByRunnerId !== runnerId ||
      !binding.platform ||
      binding.platform !== runnerPlatform
    ) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The repository binding was not validated by the selected runner on the same platform',
      );
    }
  }

  private async assertCapacity(runnerId: string, executionId: string): Promise<void> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { maxConcurrentExecutions: true },
    });
    if (!runner) {
      throw new RepositoryDispatchError(
        ERROR_CODES.RUNNER_OFFLINE,
        'The assigned runner is no longer paired',
        true,
      );
    }
    const running = await this.prisma.execution.count({
      where: { runnerId, status: 'running', id: { not: executionId } },
    });
    if (running >= Math.max(1, runner.maxConcurrentExecutions)) {
      throw new RepositoryDispatchError(
        ERROR_CODES.REPOSITORY_CONTEXT_REJECTED,
        'RUNNER_BUSY: the runner has reached its maximum concurrent executions',
        true,
      );
    }
  }

  private createPending(
    input: RepositoryDispatchInput,
    snapshot: ExecutionSnapshot,
    repositoryMessage: RunnerEnvelope,
    expectedCanonicalPath: string,
    expectedPolicyVersion: string,
  ): PendingDispatch {
    const repositoryDeferred = deferred<ExecutionRepositoryAcceptedPayload>();
    const startDeferred = deferred<ExecutionAcceptedPayload>();
    return {
      key: pendingKey(input.runnerId, input.executionId),
      executionId: input.executionId,
      runnerId: input.runnerId,
      snapshot,
      expectedPolicyVersion,
      expectedCanonicalPath,
      repositoryMessage,
      repositoryDeferred,
      startDeferred,
      startMessage: null,
      retryTimers: [],
      timeoutTimer: null,
      startTimer: null,
      settled: false,
    };
  }

  private armRepositoryTimers(pending: PendingDispatch): void {
    for (const delay of REPOSITORY_RETRY_DELAYS_MS) {
      const timer = setTimeout(() => {
        if (pending.settled) return;
        // Same message object: same messageId, same sentAt, byte-identical
        // payload. The API relies on executionId for Runner idempotency.
        this.runners.sendEnvelope(pending.runnerId, pending.repositoryMessage);
      }, delay);
      timer.unref();
      pending.retryTimers.push(timer);
    }
    const timeout = setTimeout(() => {
      pending.repositoryDeferred.reject(
        new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_HANDSHAKE_TIMEOUT,
          'The runner did not accept the repository context in time',
          true,
        ),
      );
    }, REPOSITORY_HANDSHAKE_TIMEOUT_MS);
    timeout.unref();
    pending.timeoutTimer = timeout;
  }

  private clearRepositoryTimers(pending: PendingDispatch): void {
    for (const timer of pending.retryTimers) {
      clearTimeout(timer);
    }
    pending.retryTimers = [];
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
      pending.timeoutTimer = null;
    }
  }

  private async acceptedRepository(
    pending: PendingDispatch,
    ack: ExecutionRepositoryAcceptedPayload,
  ): Promise<void> {
    await this.recheckAndTransition(pending, ack, 'repository_preparing');
    await this.recheckAndTransition(pending, null, 'repository_ready');
  }

  /**
   * Transactional binding/runner re-check plus the conditional state
   * transition. `expectedState` is the only state from which this event may
   * advance; a stale event never rolls the state backwards.
   */
  private async recheckAndTransition(
    pending: PendingDispatch,
    ack: ExecutionRepositoryAcceptedPayload | null,
    expectedState: 'repository_preparing' | 'repository_ready',
  ): Promise<void> {
    // The ACK verification, the binding re-read and the conditional state
    // transition run in one transaction. A concurrent re-validation cannot
    // swap the binding/policy between the check and the write.
    const result = await this.prisma.$transaction(async (tx) => {
      const execution = await tx.execution.findUnique({
        where: { id: pending.executionId },
        select: {
          id: true,
          status: true,
          dispatchState: true,
          runnerId: true,
          repositoryProjectId: true,
          repositoryBindingId: true,
          repositoryBindingVersion: true,
          repositoryDefaultBranch: true,
          repositoryPath: true,
          repositoryPolicyVersion: true,
        },
      });
      if (
        !execution ||
        execution.status !== 'running' ||
        execution.runnerId !== pending.runnerId ||
        execution.repositoryProjectId !== pending.snapshot.projectId ||
        execution.repositoryBindingId !== pending.snapshot.bindingId ||
        execution.repositoryBindingVersion !== pending.snapshot.bindingVersion ||
        execution.repositoryDefaultBranch !== pending.snapshot.defaultBranch
      ) {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_CONTEXT_MISMATCH,
          'The execution snapshot no longer matches the handshake',
        );
      }

      const binding = await tx.projectRepositoryBinding.findUnique({
        where: { id: pending.snapshot.bindingId },
      });
      if (!binding) {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_BINDING_CHANGED,
          'The repository binding was deleted during the handshake',
        );
      }

      // Identity/platform wins over content checks: it requires revalidation
      // on the selected runner and must not be downgraded to a path mismatch.
      const livePlatform = this.requireLivePlatform(pending);
      this.assertBindingIdentity(binding, pending.runnerId, livePlatform);

      if (
        binding.bindingVersion !== pending.snapshot.bindingVersion ||
        binding.validatedBindingVersion !== binding.bindingVersion
      ) {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_BINDING_CHANGED,
          'The repository binding version changed during the handshake',
        );
      }
      if (!binding.policyVersion) {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_POLICY_CHANGED,
          'The repository binding no longer has a validated policy version',
        );
      }
      if (!binding.canonicalPath) {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_BINDING_CHANGED,
          'The repository binding no longer has a canonical path',
        );
      }

      const expectedPolicyVersion =
        expectedState === 'repository_ready'
          ? (execution.repositoryPolicyVersion ?? pending.expectedPolicyVersion)
          : pending.expectedPolicyVersion;
      if (binding.policyVersion !== expectedPolicyVersion) {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_POLICY_CHANGED,
          'The repository path policy changed during the handshake',
        );
      }
      const expectedCanonicalPath =
        expectedState === 'repository_ready'
          ? (execution.repositoryPath ?? pending.expectedCanonicalPath)
          : pending.expectedCanonicalPath;
      if (!sameRepositoryPath(binding.canonicalPath, expectedCanonicalPath, livePlatform)) {
        throw new RepositoryDispatchError(
          ERROR_CODES.REPOSITORY_BINDING_CHANGED,
          'The repository canonical path changed during the handshake',
        );
      }

      if (ack) {
        if (
          ack.executionId !== pending.executionId ||
          ack.projectId !== pending.snapshot.projectId ||
          ack.bindingId !== pending.snapshot.bindingId ||
          ack.bindingVersion !== pending.snapshot.bindingVersion ||
          ack.defaultBranch !== pending.snapshot.defaultBranch
        ) {
          throw new RepositoryDispatchError(
            ERROR_CODES.REPOSITORY_CONTEXT_MISMATCH,
            'The repository acknowledgement does not match the execution snapshot',
          );
        }
        if (ack.policyVersion !== binding.policyVersion) {
          throw new RepositoryDispatchError(
            ERROR_CODES.REPOSITORY_POLICY_CHANGED,
            'The runner reported a different policy version than the binding',
          );
        }
        if (!sameRepositoryPath(ack.canonicalPath, binding.canonicalPath, livePlatform)) {
          throw new RepositoryDispatchError(
            ERROR_CODES.REPOSITORY_CONTEXT_MISMATCH,
            'The runner returned a repository context that does not match the binding',
          );
        }
      }

      if (expectedState === 'repository_preparing') {
        const moved = await tx.execution.updateMany({
          where: { id: pending.executionId, dispatchState: 'repository_preparing' },
          data: {
            dispatchState: 'repository_ready',
            repositoryPath: ack?.canonicalPath ?? binding.canonicalPath,
            repositoryPolicyVersion: ack?.policyVersion ?? binding.policyVersion,
            repositoryContextId: ack?.contextId ?? null,
            repositoryBaseCommit: ack?.baseCommit ?? null,
            repositoryPreparedAt: new Date(),
          },
        });
        if (moved.count === 0) {
          throw this.staleTransition(pending, 'repository_preparing');
        }
        return { state: 'repository_ready' as const, policyVersion: binding.policyVersion };
      }

      const moved = await tx.execution.updateMany({
        where: { id: pending.executionId, dispatchState: 'repository_ready' },
        data: { dispatchState: 'start_sent' },
      });
      if (moved.count === 0) {
        throw this.staleTransition(pending, 'repository_ready');
      }
      return { state: 'start_sent' as const, policyVersion: binding.policyVersion };
    });

    await this.audit(pending.executionId, result.state, {
      bindingVersion: pending.snapshot.bindingVersion,
      policyVersion: result.policyVersion,
    });
  }

  private requireLivePlatform(pending: PendingDispatch): string {
    const live = this.runners.getLiveRegistration(pending.runnerId);
    if (!live || !this.runners.isConnected(pending.runnerId)) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The selected runner is no longer connected',
      );
    }
    if (live.computerId !== pending.snapshot.computerId) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The selected runner no longer belongs to this computer',
      );
    }
    if (!REQUIRED_EXECUTION_FEATURES.every((feature) => live.features.includes(feature))) {
      throw new RepositoryDispatchError(
        ERROR_CODES.PROJECT_BINDING_NOT_READY,
        'The selected runner no longer advertises the repository handshake features',
      );
    }
    return live.platform;
  }

  private staleTransition(pending: PendingDispatch, expected: string): RepositoryDispatchError {
    this.logger.warn({
      eventType: 'execution.dispatch_state_stale',
      message: 'Handshake transition was rejected by the conditional update',
      runnerId: pending.runnerId,
      executionId: pending.executionId,
      status: 'warning',
      expected,
    });
    return new RepositoryDispatchError(
      ERROR_CODES.REPOSITORY_CONTEXT_MISMATCH,
      'The execution dispatch state changed during the handshake',
    );
  }

  private async onProtocolEvent(event: RunnerProtocolEvent): Promise<void> {
    const key = pendingKey(event.runnerId, event.payload.executionId);
    const pending = this.pending.get(key);
    if (!pending || pending.settled) {
      this.logger.info({
        eventType: 'repository.protocol_event_stale',
        message: 'Ignoring a stale repository handshake event',
        runnerId: event.runnerId,
        executionId: event.payload.executionId,
        status: 'warning',
        event: event.type,
      });
      return;
    }

    if (event.type === 'execution.repository.accepted') {
      pending.repositoryDeferred.resolve(event.payload);
      return;
    }
    if (event.type === 'execution.repository.rejected') {
      pending.repositoryDeferred.reject(
        new RepositoryDispatchError(
          event.payload.code,
          event.payload.message,
          event.payload.retryable,
        ),
      );
      return;
    }
    if (event.type === 'execution.start.rejected') {
      if (!pending.startMessage) {
        return;
      }
      pending.startDeferred.reject(
        new RepositoryDispatchError(
          event.payload.code,
          event.payload.message,
          event.payload.retryable,
        ),
      );
      return;
    }
    if (event.type === 'execution.accepted') {
      if (!pending.startMessage) {
        return;
      }
      const moved = await this.prisma.execution.updateMany({
        where: { id: pending.executionId, dispatchState: 'start_sent' },
        data: { dispatchState: 'running' },
      });
      if (moved.count === 0) {
        const current = await this.prisma.execution.findUnique({
          where: { id: pending.executionId },
          select: { status: true, dispatchState: true },
        });
        if (current?.dispatchState === 'running' && current.status === 'running') {
          // Duplicate execution.accepted: transitioned once already.
          pending.startDeferred.resolve(event.payload);
          return;
        }
        this.logger.warn({
          eventType: 'execution.dispatch_state_stale',
          message: 'execution.accepted arrived outside start_sent',
          runnerId: event.runnerId,
          executionId: pending.executionId,
          status: 'warning',
          received: current?.dispatchState,
        });
        return;
      }
      pending.startDeferred.resolve(event.payload);
    }
  }

  private rejectPending(pending: PendingDispatch, error: unknown): void {
    if (pending.settled) return;
    this.clearRepositoryTimers(pending);
    if (pending.startTimer) {
      clearTimeout(pending.startTimer);
      pending.startTimer = null;
    }
    pending.repositoryDeferred.reject(error);
    pending.startDeferred.reject(error);
  }

  private clearPending(pending: PendingDispatch): void {
    pending.settled = true;
    this.clearRepositoryTimers(pending);
    if (pending.startTimer) {
      clearTimeout(pending.startTimer);
      pending.startTimer = null;
    }
    if (this.pending.get(pending.key) === pending) {
      this.pending.delete(pending.key);
    }
  }

  private async markBindingUnverified(bindingId: string, bindingVersion: number): Promise<void> {
    await this.prisma.projectRepositoryBinding
      .updateMany({
        where: { id: bindingId, bindingVersion },
        data: {
          status: 'unverified',
          canonicalPath: null,
          validatedByRunnerId: null,
          validatedBindingVersion: null,
          policyVersion: null,
          validationErrorCode: ERROR_CODES.REPOSITORY_POLICY_CHANGED,
          validationError: 'The runner path policy changed; revalidate the binding',
        },
      })
      .catch((error: unknown) => {
        this.logger.error({
          eventType: 'repository.binding_unverified_failed',
          message: 'Could not mark the binding unverified after a policy change',
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async audit(
    executionId: string,
    state: string,
    details: {
      bindingVersion?: number | null;
      policyVersion?: string | null;
      code?: string | null;
      message?: string | null;
    } = {},
  ): Promise<void> {
    try {
      await this.prisma.repositoryHandshakeEvent.create({
        data: {
          executionId,
          state,
          bindingVersion: details.bindingVersion ?? null,
          policyVersion: details.policyVersion ?? null,
          code: details.code ?? null,
          message: details.message ?? null,
        },
      });
    } catch {
      // The audit trail is best-effort and must never break the handshake.
    }
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // An unhandled rejection can surface before dispatch awaits the deferred.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function pendingKey(runnerId: string, executionId: string): string {
  return `${runnerId}:${executionId}`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return ERROR_CODES.REPOSITORY_CONTEXT_REJECTED;
}
