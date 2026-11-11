import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ERROR_CODES,
  type ErrorCode,
  type ProjectBindingStatus,
  type RepositoryValidatePayload,
  type RepositoryValidationResultDto,
  type RunnerFeature,
} from '@raft-lite/contracts';
import { DEFAULT_WORKSPACE_ID } from '../../common/constants';
import { AppException } from '../../common/errors/app.exception';
import { AppLogger } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { projectBindingRelations, toProjectBindingDto } from '../../common/serializers';
import { RunnerRegistryService, type RepositoryValidationEvent } from './runner-registry.service';

const DEFAULT_VALIDATION_TIMEOUT_MS = 15_000;
const MIN_VALIDATION_TIMEOUT_MS = 5_000;
const MAX_VALIDATION_TIMEOUT_MS = 30_000;
const REQUIRED_FEATURES: readonly RunnerFeature[] = [
  'repository-validation-v1',
  'repository-path-policy-v1',
];

interface PendingValidation {
  requestId: string;
  messageId: string;
  runnerId: string;
  projectId: string;
  computerId: string;
  bindingId: string;
  bindingVersion: number;
  payload: RepositoryValidatePayload;
  retryTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  retried: boolean;
  resolve: (result: RepositoryValidationResultDto) => void;
  reject: (error: unknown) => void;
}

/**
 * Owns the complete API-side validation lifecycle:
 *
 * preconditions → requestId → DB guard → send/retry → correlation →
 * conditional binding update → DTO.
 *
 * It never reads the runner filesystem and never fills in runner-reported
 * facts. A binding becomes `ready` only from a fully correlated successful
 * `repository.validation` produced by the authenticated runner connection.
 */
@Injectable()
export class RepositoryValidationService implements OnModuleInit, OnModuleDestroy {
  private readonly pending = new Map<string, PendingValidation>();
  private readonly timeoutMs: number;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runners: RunnerRegistryService,
    private readonly logger: AppLogger,
  ) {
    const configured = Number(
      process.env.HAFT_REPOSITORY_VALIDATION_TIMEOUT_MS ??
        process.env.REPOSITORY_VALIDATION_TIMEOUT_MS ??
        DEFAULT_VALIDATION_TIMEOUT_MS,
    );
    this.timeoutMs = Number.isFinite(configured)
      ? Math.min(MAX_VALIDATION_TIMEOUT_MS, Math.max(MIN_VALIDATION_TIMEOUT_MS, configured))
      : DEFAULT_VALIDATION_TIMEOUT_MS;
  }

  onModuleInit(): void {
    this.unsubscribe = this.runners.onRepositoryValidation((event) => {
      this.handleValidationEvent(event);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const pending of this.pending.values()) {
      // Best-effort: clear the persisted request marker so a restart does not
      // leave the binding looking like a validation is still in flight.
      void this.abandonPending(
        pending,
        ERROR_CODES.REPOSITORY_VALIDATION_TIMEOUT,
        'The API shut down before repository validation completed',
      );
      pending.reject(
        new AppException(
          ERROR_CODES.REPOSITORY_VALIDATION_TIMEOUT,
          'The API is shutting down before repository validation completed',
          HttpStatus.GATEWAY_TIMEOUT,
        ),
      );
    }
    this.pending.clear();
  }

  async validateBinding(
    projectId: string,
    bindingId: string,
  ): Promise<RepositoryValidationResultDto> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId: DEFAULT_WORKSPACE_ID },
      select: { id: true },
    });
    if (!project) {
      throw new AppException(
        ERROR_CODES.PROJECT_NOT_FOUND,
        'Project not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const binding = await this.prisma.projectRepositoryBinding.findFirst({
      where: { id: bindingId, projectId },
    });
    if (!binding) {
      throw new AppException(
        ERROR_CODES.BINDING_NOT_FOUND,
        'Repository binding not found',
        HttpStatus.NOT_FOUND,
        { projectId, bindingId },
      );
    }

    const runner = await this.prisma.runner.findUnique({
      where: { computerId: binding.computerId },
    });
    if (!runner || !this.runners.isConnected(runner.id)) {
      throw new AppException(
        ERROR_CODES.RUNNER_OFFLINE,
        'The runner for this computer is offline',
        HttpStatus.CONFLICT,
        { computerId: binding.computerId },
      );
    }
    if (!this.runners.hasLiveFeatures(runner.id, REQUIRED_FEATURES)) {
      throw new AppException(
        ERROR_CODES.RUNNER_FEATURE_UNSUPPORTED,
        'The runner does not support repository validation; upgrade the runner',
        HttpStatus.CONFLICT,
        { runnerId: runner.id, requiredFeatures: [...REQUIRED_FEATURES] },
      );
    }

    const requestId = randomUUID();
    const messageId = randomUUID();
    const payload: RepositoryValidatePayload = {
      requestId,
      projectId,
      computerId: binding.computerId,
      bindingId: binding.id,
      bindingVersion: binding.bindingVersion,
      path: binding.path,
    };

    const guarded = await this.prisma.projectRepositoryBinding.updateMany({
      where: {
        id: binding.id,
        projectId,
        computerId: binding.computerId,
        bindingVersion: binding.bindingVersion,
      },
      data: {
        validationRequestId: requestId,
        validationErrorCode: null,
        validationError: null,
      },
    });
    if (guarded.count === 0) {
      throw new AppException(
        ERROR_CODES.BINDING_VERSION_STALE,
        'The binding changed before validation started; validate again',
        HttpStatus.CONFLICT,
        { projectId, bindingId },
      );
    }

    const promise = new Promise<RepositoryValidationResultDto>((resolve, reject) => {
      const pending: PendingValidation = {
        requestId,
        messageId,
        runnerId: runner.id,
        projectId,
        computerId: binding.computerId,
        bindingId: binding.id,
        bindingVersion: binding.bindingVersion,
        payload,
        retryTimer: null,
        timeoutTimer: null,
        retried: false,
        resolve,
        reject,
      };
      this.pending.set(requestId, pending);

      pending.timeoutTimer = setTimeout(() => {
        void this.handleTimeout(pending);
      }, this.timeoutMs);
      pending.timeoutTimer.unref();

      // One retry at half-timeout with the exact same messageId and payload.
      pending.retryTimer = setTimeout(
        () => {
          if (this.pending.get(requestId) !== pending || pending.retried) {
            return;
          }
          pending.retried = true;
          try {
            const sent = this.runners.sendRepositoryValidate(
              pending.runnerId,
              pending.payload,
              pending.messageId,
            );
            if (!sent) {
              this.logger.warn({
                eventType: 'repository.validation_retry_failed',
                message: 'Could not retry repository validation because the runner is offline',
                runnerId: pending.runnerId,
                status: 'warning',
              });
            }
          } catch (error) {
            this.logger.error({
              eventType: 'repository.validation_retry_failed',
              message: 'The runner transport threw while retrying repository validation',
              runnerId: pending.runnerId,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            });
            const retryFailure = new AppException(
              ERROR_CODES.REPO_VALIDATION_FAILED,
              'Could not retry the repository validation request',
              HttpStatus.CONFLICT,
            );
            void this.abandonPending(
              pending,
              ERROR_CODES.REPO_VALIDATION_FAILED,
              'Could not retry the repository validation request',
            ).finally(() => pending.reject(retryFailure));
          }
        },
        Math.floor(this.timeoutMs / 2),
      );
      pending.retryTimer.unref();
    });

    let sent = false;
    try {
      sent = this.runners.sendRepositoryValidate(runner.id, payload, messageId);
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        await this.abandonPending(
          pending,
          ERROR_CODES.REPO_VALIDATION_FAILED,
          'Could not send the repository validation request',
        );
      }
      this.logger.error({
        eventType: 'repository.validation_send_failed',
        message: 'The runner transport threw while sending repository validation',
        runnerId: runner.id,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppException(
        ERROR_CODES.REPO_VALIDATION_FAILED,
        'Could not send the repository validation request',
        HttpStatus.CONFLICT,
      );
    }
    if (!sent) {
      const pending = this.pending.get(requestId);
      if (pending) {
        await this.abandonPending(pending, ERROR_CODES.RUNNER_OFFLINE, 'Runner disconnected');
      }
      throw new AppException(
        ERROR_CODES.RUNNER_OFFLINE,
        'The runner disconnected before repository validation could be sent',
        HttpStatus.CONFLICT,
      );
    }

    return promise;
  }

  private handleValidationEvent(event: RepositoryValidationEvent): void {
    const pending = this.pending.get(event.payload.requestId);
    if (!pending) {
      this.logger.warn({
        eventType: 'repository.validation_stale',
        message: 'Discarded a repository validation response without a pending request',
        runnerId: event.runnerId,
        status: 'warning',
        error: ERROR_CODES.STALE_REPOSITORY_VALIDATION,
      });
      return;
    }

    const correlationError = this.correlate(pending, event);
    if (correlationError) {
      this.settle(pending);
      void this.abandonPending(
        pending,
        ERROR_CODES.REPO_VALIDATION_FAILED,
        correlationError.message,
      ).finally(() => pending.reject(correlationError));
      return;
    }

    this.settle(pending);
    void this.applyResult(pending, event).then(
      (result) => pending.resolve(result),
      (error: unknown) => pending.reject(error),
    );
  }

  private correlate(
    pending: PendingValidation,
    event: RepositoryValidationEvent,
  ): AppException | null {
    const response = event.payload;
    if (event.runnerId !== pending.runnerId) {
      return this.correlationFailure(
        event,
        `Response came from runner ${event.runnerId}, expected ${pending.runnerId}`,
      );
    }
    if (event.computerId !== pending.computerId) {
      return this.correlationFailure(event, 'Response came from a different computer connection');
    }
    if (event.platform !== response.platform) {
      return this.correlationFailure(
        event,
        `Response platform ${response.platform} does not match the live connection platform ${event.platform}`,
      );
    }
    if (
      response.projectId !== pending.projectId ||
      response.computerId !== pending.computerId ||
      response.bindingId !== pending.bindingId ||
      response.bindingVersion !== pending.bindingVersion
    ) {
      return this.correlationFailure(
        event,
        'Response project/computer/binding/version does not match the validation request',
      );
    }
    return null;
  }

  private correlationFailure(event: RepositoryValidationEvent, message: string): AppException {
    this.logger.warn({
      eventType: 'repository.validation_uncorrelated',
      message,
      runnerId: event.runnerId,
      status: 'warning',
      error: ERROR_CODES.REPO_VALIDATION_FAILED,
      requestId: event.payload.requestId,
    });
    return new AppException(ERROR_CODES.REPO_VALIDATION_FAILED, message, HttpStatus.CONFLICT);
  }

  private async applyResult(
    pending: PendingValidation,
    event: RepositoryValidationEvent,
  ): Promise<RepositoryValidationResultDto> {
    const response = event.payload;
    const current = await this.prisma.projectRepositoryBinding.findFirst({
      where: {
        id: pending.bindingId,
        projectId: pending.projectId,
        computerId: pending.computerId,
      },
      select: {
        id: true,
        bindingVersion: true,
        validationRequestId: true,
      },
    });
    if (!current) {
      throw new AppException(
        ERROR_CODES.BINDING_NOT_FOUND,
        'Repository binding was deleted while validation was running',
        HttpStatus.NOT_FOUND,
        { projectId: pending.projectId, bindingId: pending.bindingId },
      );
    }
    if (
      current.bindingVersion !== pending.bindingVersion ||
      current.validationRequestId !== pending.requestId
    ) {
      this.logger.warn({
        eventType: 'repository.validation_stale',
        message: 'A newer validation request or binding version superseded this response',
        runnerId: event.runnerId,
        status: 'warning',
        error: ERROR_CODES.STALE_REPOSITORY_VALIDATION,
        bindingId: pending.bindingId,
      });
      throw new AppException(
        ERROR_CODES.BINDING_VERSION_STALE,
        'The binding changed while validation was running; validate again',
        HttpStatus.CONFLICT,
        {
          projectId: pending.projectId,
          bindingId: pending.bindingId,
          bindingVersion: pending.bindingVersion,
        },
      );
    }

    const outcome = this.normalizeOutcome(response);
    const validatedAt = new Date();
    const where = {
      id: pending.bindingId,
      projectId: pending.projectId,
      computerId: pending.computerId,
      bindingVersion: pending.bindingVersion,
      validationRequestId: pending.requestId,
    };
    const updatedCount = outcome.ok
      ? (
          await this.prisma.projectRepositoryBinding.updateMany({
            where,
            data: {
              status: 'ready',
              canonicalPath: response.canonicalPath,
              platform: response.platform,
              policyVersion: response.policyVersion,
              validatedByRunnerId: event.runnerId,
              validatedBindingVersion: pending.bindingVersion,
              lastValidatedAt: validatedAt,
              validationRequestId: null,
              validationErrorCode: null,
              validationError: null,
            },
          })
        ).count
      : (
          await this.prisma.projectRepositoryBinding.updateMany({
            where,
            data: {
              status: outcome.bindingStatus,
              // Never keep metadata that claims a failed path is executable.
              canonicalPath: null,
              platform: null,
              policyVersion: null,
              validatedByRunnerId: null,
              validatedBindingVersion: null,
              lastValidatedAt: validatedAt,
              validationRequestId: null,
              validationErrorCode: outcome.errorCode,
              validationError: outcome.message,
            },
          })
        ).count;

    if (updatedCount === 0) {
      this.logger.warn({
        eventType: 'repository.validation_stale',
        message: 'Conditional binding update matched no row; the response was discarded',
        runnerId: event.runnerId,
        status: 'warning',
        error: ERROR_CODES.STALE_REPOSITORY_VALIDATION,
        bindingId: pending.bindingId,
      });
      throw new AppException(
        ERROR_CODES.BINDING_VERSION_STALE,
        'The binding changed while validation was running; validate again',
        HttpStatus.CONFLICT,
        {
          projectId: pending.projectId,
          bindingId: pending.bindingId,
          bindingVersion: pending.bindingVersion,
        },
      );
    }

    const updated = await this.prisma.projectRepositoryBinding.findUnique({
      where: { id: pending.bindingId },
      include: projectBindingRelations,
    });
    if (!updated) {
      // The row can disappear between the conditional update and this read.
      throw new AppException(
        ERROR_CODES.BINDING_NOT_FOUND,
        'Repository binding was deleted while validation was running',
        HttpStatus.NOT_FOUND,
        { projectId: pending.projectId, bindingId: pending.bindingId },
      );
    }

    return {
      binding: toProjectBindingDto(updated),
      status: outcome.bindingStatus,
      canonicalPath: outcome.ok ? (response.canonicalPath ?? null) : null,
      platform: outcome.ok ? response.platform : null,
      policyVersion: outcome.ok ? response.policyVersion : null,
      headCommit: outcome.ok ? (response.headCommit ?? null) : null,
      validatedAt: validatedAt.toISOString(),
      errorCode: outcome.ok ? null : outcome.errorCode,
      message: outcome.ok ? null : outcome.message,
    };
  }

  private normalizeOutcome(response: RepositoryValidationEvent['payload']): {
    ok: boolean;
    bindingStatus: ProjectBindingStatus;
    errorCode: ErrorCode | null;
    message: string | null;
  } {
    // Branch existence is a handshake concern, not a path-validation result
    // (plan §8.5). Check it before the success branch: a payload may legally
    // carry `ok=true` plus an errorCode, and the branch code must never be
    // accepted or persisted as a validation outcome.
    if (response.errorCode === ERROR_CODES.REPO_DEFAULT_BRANCH_NOT_FOUND) {
      return {
        ok: false,
        bindingStatus: 'error',
        errorCode: ERROR_CODES.REPO_VALIDATION_FAILED,
        message:
          'Runner returned a branch error from repository validation; this is a protocol violation',
      };
    }

    if (response.ok) {
      if (
        !response.canonicalPath ||
        !response.headCommit ||
        !response.policyVersion ||
        !response.platform
      ) {
        return {
          ok: false,
          bindingStatus: 'error',
          errorCode: ERROR_CODES.REPO_VALIDATION_FAILED,
          message: 'Runner returned an incomplete successful validation result',
        };
      }
      return { ok: true, bindingStatus: 'ready', errorCode: null, message: null };
    }

    const errorCode = response.errorCode ?? ERROR_CODES.REPO_VALIDATION_FAILED;
    return {
      ok: false,
      bindingStatus:
        errorCode === ERROR_CODES.REPO_PATH_NOT_FOUND ? ('missing' as const) : ('error' as const),
      errorCode,
      message: response.message ?? 'Repository validation failed',
    };
  }

  private async handleTimeout(pending: PendingValidation): Promise<void> {
    if (this.pending.get(pending.requestId) !== pending) {
      return;
    }
    const error = new AppException(
      ERROR_CODES.REPOSITORY_VALIDATION_TIMEOUT,
      'The runner did not answer repository validation in time; the binding state was not changed',
      HttpStatus.GATEWAY_TIMEOUT,
      {
        projectId: pending.projectId,
        bindingId: pending.bindingId,
        bindingVersion: pending.bindingVersion,
      },
    );
    await this.abandonPending(
      pending,
      ERROR_CODES.REPOSITORY_VALIDATION_TIMEOUT,
      'The runner did not answer repository validation in time',
    );
    pending.reject(error);
  }

  private settle(pending: PendingValidation): void {
    if (this.pending.get(pending.requestId) === pending) {
      this.pending.delete(pending.requestId);
    }
    this.clearTimers(pending);
  }

  /**
   * Clears the request marker and records the attempt error, but only when this
   * exact request still owns the binding. A newer request's marker is never
   * cleared by an older timeout or uncorrelated response.
   */
  private async abandonPending(
    pending: PendingValidation,
    errorCode: ErrorCode,
    message: string,
  ): Promise<void> {
    this.settle(pending);
    await this.prisma.projectRepositoryBinding
      .updateMany({
        where: {
          id: pending.bindingId,
          projectId: pending.projectId,
          computerId: pending.computerId,
          bindingVersion: pending.bindingVersion,
          validationRequestId: pending.requestId,
        },
        data: {
          validationRequestId: null,
          validationErrorCode: errorCode,
          validationError: message,
        },
      })
      .catch((error: unknown) => {
        this.logger.error({
          eventType: 'repository.validation_cleanup_failed',
          message: 'Could not clear the failed validation request marker',
          runnerId: pending.runnerId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private clearTimers(pending: PendingValidation): void {
    if (pending.retryTimer) {
      clearTimeout(pending.retryTimer);
      pending.retryTimer = null;
    }
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
      pending.timeoutTimer = null;
    }
  }
}
