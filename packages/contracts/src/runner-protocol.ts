import { z } from 'zod';
import {
  AGENT_RUNTIMES,
  ERROR_CODES,
  EXECUTION_DIFF_MAX_BYTES,
  EXECUTION_PHASES,
  LOG_COLLECTION_REASON_CODES,
  LOG_COLLECTION_STATUSES,
  LOG_LEVELS,
  LOG_STREAMS,
  RUNNER_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_RUNTIMES,
  TERMINAL_OUTCOMES,
  type RunnerFeature,
} from './constants';

/**
 * Runner protocol v1.
 *
 * Every message is wrapped in a strict envelope. Server -> Runner and
 * Runner -> Server messages are versioned and carry a stable messageId so both
 * sides can implement at-least-once delivery with idempotent handling.
 */

const id = z.string().trim().min(1).max(120);
const isoDateTime = z.string().datetime();

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

export const runnerRuntimeSchema = z.enum(RUNNER_RUNTIMES);
export const runnerFeatureSchema = z.enum(RUNNER_FEATURES);
export const executionPhaseSchema = z.enum(EXECUTION_PHASES);
export const logStreamSchema = z.enum(LOG_STREAMS);
export const runnerLogLevelSchema = z.enum(LOG_LEVELS);

/**
 * Socket.IO handshake payload used to pair or re-authenticate a runner.
 * The server accepts either a previously issued runner token or a one-time
 * bootstrap token; the token is never forwarded to a CLI process.
 */
export const runnerHandshakeSchema = z
  .object({
    runnerId: id,
    computerId: id,
    protocolVersion: z.number().int().positive().optional(),
    token: z.string().min(20).max(300).optional(),
    bootstrapToken: z.string().min(8).max(500).optional(),
  })
  .strict();

export const runnerEnvelopeBaseSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
    messageId: id,
    runnerId: id,
    type: z.string().trim().min(1).max(80),
    sentAt: isoDateTime,
    payload: z.unknown(),
  })
  .strict();

function envelope<T extends z.ZodTypeAny, Type extends string>(type: Type, payload: T) {
  return z
    .object({
      protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
      messageId: id,
      runnerId: id,
      type: z.literal(type),
      sentAt: isoDateTime,
      payload,
    })
    .strict();
}

/* ------------------------------------------------------------------ */
/* Shared payload fragments                                            */
/* ------------------------------------------------------------------ */

export const runnerRuntimeCapabilitySchema = z
  .object({
    runtime: runnerRuntimeSchema,
    installed: z.boolean(),
    version: z.string().trim().max(120).nullable(),
    authenticated: z.boolean(),
    message: z.string().trim().max(500).nullable(),
  })
  .strict();

const runnerFeaturesSchema = z
  .array(runnerFeatureSchema)
  .max(RUNNER_FEATURES.length)
  .default([])
  .superRefine((features, ctx) => {
    const seen = new Set<string>();
    features.forEach((feature, index) => {
      if (seen.has(feature)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate runner feature: ${feature}`,
        });
      }
      seen.add(feature);
    });
  });

export const runnerCapabilitiesSchema = z
  .object({
    runtimes: z.array(runnerRuntimeCapabilitySchema).max(10),
    projectIds: z.array(id).max(200),
    maxConcurrentExecutions: z.number().int().min(1).max(32).nullable().optional(),
    /**
     * Additive Phase 2 capability list. Missing means the empty set, never
     * "supports everything": older runners must keep their old behaviour and
     * new features stay fail-closed.
     */
    features: runnerFeaturesSchema,
  })
  .strict();

export const runnerLogEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    eventId: id,
    stream: logStreamSchema,
    level: runnerLogLevelSchema,
    message: z.string().min(1).max(8000),
    timestamp: isoDateTime,
  })
  .strict();

export const gitExecutionResultSchema = z
  .object({
    branchName: z.string().trim().min(1).max(300),
    baseCommit: z.string().trim().min(1).max(120),
    headCommit: z.string().trim().min(1).max(120).nullable(),
    changedFiles: z.number().int().min(0),
    diffStat: z.string().max(20000),
    gitStatus: z.string().max(20000),
    diff: z.string().max(EXECUTION_DIFF_MAX_BYTES),
    diffTruncated: z.boolean(),
  })
  .strict();

export const runtimeExecutionOptionsSchema = z
  .object({
    model: z.string().trim().max(200).nullable().optional(),
    agent: z.string().trim().max(200).nullable().optional(),
    variant: z.string().trim().max(200).nullable().optional(),
    sandbox: z.string().trim().max(100).nullable().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(24 * 60 * 60 * 1000)
      .optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Phase 2 additive protocol fragments                                 */
/* ------------------------------------------------------------------ */

export const errorCodeSchema = z.nativeEnum(ERROR_CODES);
export const terminalOutcomeSchema = z.enum(TERMINAL_OUTCOMES);
export const logCollectionStatusSchema = z.enum(LOG_COLLECTION_STATUSES);
export const logCollectionReasonCodeSchema = z.enum(LOG_COLLECTION_REASON_CODES);

/**
 * Repository paths are opaque to the wire contract. Absolute-path, realpath
 * and allowed-root enforcement belongs to the runner path policy (P2-02).
 */
export const repositoryPathSchema = z
  .string()
  .min(1, 'Repository path is required')
  .max(4096, 'Repository path is too long')
  .refine((value) => !value.includes('\0'), 'Repository path must not contain NUL');

/**
 * Contract-level default branch validation. Whether the branch exists in the
 * repository is verified by the runner during repository handshake (P2-02).
 */
export const repositoryDefaultBranchSchema = z
  .string()
  .min(1, 'Default branch is required')
  .max(255, 'Default branch is too long')
  .superRefine((value, ctx) => {
    if (/\s/.test(value) || hasAsciiControlCharacter(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Default branch must not contain whitespace or control characters',
      });
    }
    if (value.startsWith('-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Default branch must not start with "-"',
      });
    }
    if (value.includes('..')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Default branch must not contain ".."',
      });
    }
    if (value === 'HEAD') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Default branch must not be HEAD',
      });
    }
  });

export const missingLogRangeSchema = z
  .object({
    fromRunnerSeq: z.number().int().min(1),
    toRunnerSeq: z.number().int().min(1),
  })
  .strict()
  .refine((value) => value.fromRunnerSeq <= value.toRunnerSeq, {
    message: 'fromRunnerSeq must not exceed toRunnerSeq',
    path: ['toRunnerSeq'],
  });

/**
 * Explicit log collection metadata for `execution.terminal`.
 *
 * `status=complete` is only valid when the allocated, appended and contiguous
 * prefixes are identical and no permanent gap is reported. `status=incomplete`
 * always carries a reason code. Omitting the whole object means "unknown" to
 * consumers; this schema intentionally applies no default.
 */
export const terminalLogCollectionSchema = z
  .object({
    status: logCollectionStatusSchema,
    reasonCode: logCollectionReasonCodeSchema.optional(),
    allocatedThroughRunnerSeq: z.number().int().min(0),
    appendedThroughRunnerSeq: z.number().int().min(0),
    missingRanges: z.array(missingLogRangeSchema).max(1000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.appendedThroughRunnerSeq > value.allocatedThroughRunnerSeq) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appendedThroughRunnerSeq'],
        message: 'appendedThroughRunnerSeq must not exceed allocatedThroughRunnerSeq',
      });
    }
    if (value.status === 'complete') {
      if (value.allocatedThroughRunnerSeq !== value.appendedThroughRunnerSeq) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'complete requires allocatedThroughRunnerSeq == appendedThroughRunnerSeq',
        });
      }
      if ((value.missingRanges?.length ?? 0) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['missingRanges'],
          message: 'complete must not report missing ranges',
        });
      }
    } else if (!value.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'incomplete requires a reasonCode',
      });
    }

    let previousTo = 0;
    (value.missingRanges ?? []).forEach((range, index) => {
      if (range.toRunnerSeq > value.appendedThroughRunnerSeq) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['missingRanges', index, 'toRunnerSeq'],
          message: 'missing range must not exceed appendedThroughRunnerSeq',
        });
      }
      if (range.fromRunnerSeq <= previousTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['missingRanges', index, 'fromRunnerSeq'],
          message: 'missing ranges must be ascending and non-overlapping',
        });
      }
      previousTo = range.toRunnerSeq;
    });
  });

export const executionTerminalPayloadSchema = z
  .object({
    executionId: id,
    outcome: terminalOutcomeSchema,
    lastRunnerSeq: z.number().int().min(0),
    logCollection: terminalLogCollectionSchema.optional(),
    exitCode: z.number().int().nullable(),
    summary: z.string().max(20000).nullable(),
    git: gitExecutionResultSchema.nullable(),
    reason: z.string().trim().max(2000).nullable().optional(),
    errorCode: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const collection = value.logCollection;
    if (!collection) {
      return;
    }
    if (value.lastRunnerSeq > collection.appendedThroughRunnerSeq) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastRunnerSeq'],
        message: 'lastRunnerSeq must not exceed appendedThroughRunnerSeq',
      });
    }
    if (
      collection.status === 'complete' &&
      value.lastRunnerSeq !== collection.appendedThroughRunnerSeq
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastRunnerSeq'],
        message: 'complete requires lastRunnerSeq == appendedThroughRunnerSeq',
      });
    }
    (collection.missingRanges ?? []).forEach((range, index) => {
      if (range.fromRunnerSeq <= value.lastRunnerSeq) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['logCollection', 'missingRanges', index, 'fromRunnerSeq'],
          message: 'missing ranges must not intersect the contiguous prefix',
        });
      }
    });
  });

/* ------------------------------------------------------------------ */
/* Server -> Runner                                                    */
/* ------------------------------------------------------------------ */

export const runnerWelcomePayloadSchema = z
  .object({
    issuedToken: z.string().min(20).max(300).nullable(),
    serverTime: isoDateTime,
    heartbeatIntervalMs: z.number().int().min(1000).max(120_000),
    reconnectGraceMs: z.number().int().min(1000).max(600_000),
    maxConcurrentExecutions: z.number().int().min(1).max(32),
  })
  .strict();

export const runnerErrorPayloadSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1000),
    fatal: z.boolean(),
  })
  .strict();

export const executionStartPayloadSchema = z
  .object({
    executionId: id,
    runtime: runnerRuntimeSchema,
    taskId: id,
    taskTitle: z.string().trim().min(1).max(1000),
    taskDescription: z.string().max(20000),
    projectId: id,
    prompt: z.string().min(1).max(40000),
    options: runtimeExecutionOptionsSchema.default({}),
  })
  .strict();

export const executionCancelPayloadSchema = z
  .object({
    executionId: id,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const executionReconcilePayloadSchema = z
  .object({
    reason: z.enum(['server_restart', 'reconnect', 'manual']),
    executionIds: z.array(id).max(500),
  })
  .strict();

export const executionLogAckPayloadSchema = z
  .object({
    executionId: id,
    throughSeq: z.number().int().min(0),
  })
  .strict();

export const repositoryValidatePayloadSchema = z
  .object({
    requestId: id,
    projectId: id,
    computerId: id,
    bindingId: id,
    bindingVersion: z.number().int().min(1),
    path: repositoryPathSchema,
  })
  .strict();

export const executionRepositoryPayloadSchema = z
  .object({
    executionId: id,
    projectId: id,
    bindingId: id,
    bindingVersion: z.number().int().min(1),
    path: repositoryPathSchema,
    defaultBranch: repositoryDefaultBranchSchema,
    policyVersion: z.string().trim().min(1).max(100),
  })
  .strict();

export const executionLogResendPayloadSchema = z
  .object({
    executionId: id,
    fromRunnerSeq: z.number().int().min(1),
    toRunnerSeq: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.toRunnerSeq !== undefined && value.toRunnerSeq < value.fromRunnerSeq) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toRunnerSeq'],
        message: 'toRunnerSeq must be greater than or equal to fromRunnerSeq',
      });
    }
  });

export const runnerWelcomeMessageSchema = envelope('runner.welcome', runnerWelcomePayloadSchema);
export const runnerErrorMessageSchema = envelope('runner.error', runnerErrorPayloadSchema);
export const executionStartMessageSchema = envelope('execution.start', executionStartPayloadSchema);
export const executionCancelMessageSchema = envelope(
  'execution.cancel',
  executionCancelPayloadSchema,
);
export const executionReconcileMessageSchema = envelope(
  'execution.reconcile',
  executionReconcilePayloadSchema,
);
export const executionLogAckMessageSchema = envelope(
  'execution.log.ack',
  executionLogAckPayloadSchema,
);
export const repositoryValidateMessageSchema = envelope(
  'repository.validate',
  repositoryValidatePayloadSchema,
);
export const executionRepositoryMessageSchema = envelope(
  'execution.repository',
  executionRepositoryPayloadSchema,
);
export const executionLogResendMessageSchema = envelope(
  'execution.log.resend',
  executionLogResendPayloadSchema,
);

export const SERVER_TO_RUNNER_MESSAGE_TYPES = [
  'runner.welcome',
  'runner.error',
  'execution.start',
  'execution.cancel',
  'execution.reconcile',
  'execution.log.ack',
  'repository.validate',
  'execution.repository',
  'execution.log.resend',
] as const;

/* ------------------------------------------------------------------ */
/* Runner -> Server                                                    */
/* ------------------------------------------------------------------ */

export const runnerRegisterPayloadSchema = z
  .object({
    computerId: id,
    runnerVersion: z.string().trim().min(1).max(120),
    platform: z.string().trim().min(1).max(80),
    architecture: z.string().trim().min(1).max(80),
    capabilities: runnerCapabilitiesSchema,
  })
  .strict();

export const runnerHeartbeatPayloadSchema = z
  .object({
    activeExecutionIds: z.array(id).max(64),
    status: z.enum(['online', 'busy', 'degraded']),
    uptimeMs: z.number().int().min(0).optional(),
  })
  .strict();

export const executionAcceptedPayloadSchema = z
  .object({
    executionId: id,
    acceptedAt: isoDateTime,
  })
  .strict();

export const executionPhasePayloadSchema = z
  .object({
    executionId: id,
    phase: executionPhaseSchema,
    message: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const executionLogPayloadSchema = z
  .object({
    executionId: id,
    entries: z.array(runnerLogEntrySchema).min(1).max(200),
  })
  .strict();

export const executionProgressPayloadSchema = z
  .object({
    executionId: id,
    progress: z.number().int().min(0).max(100),
    step: z.number().int().min(0).optional(),
    progressMode: z.enum(['determinate', 'indeterminate']).optional(),
  })
  .strict();

export const executionCompletedPayloadSchema = z
  .object({
    executionId: id,
    exitCode: z.number().int().nullable(),
    summary: z.string().max(20000).nullable(),
    git: gitExecutionResultSchema.nullable(),
  })
  .strict();

export const executionFailedPayloadSchema = z
  .object({
    executionId: id,
    reason: z.string().trim().min(1).max(2000),
    exitCode: z.number().int().nullable(),
    summary: z.string().max(20000).nullable(),
    git: gitExecutionResultSchema.nullable(),
  })
  .strict();

export const executionCancelledPayloadSchema = z
  .object({
    executionId: id,
    reason: z.string().trim().max(500).nullable(),
    exitCode: z.number().int().nullable(),
    git: gitExecutionResultSchema.nullable(),
  })
  .strict();

export const repositoryValidationPayloadSchema = z
  .object({
    requestId: id,
    projectId: id,
    computerId: id,
    bindingId: id,
    bindingVersion: z.number().int().min(1),
    ok: z.boolean(),
    platform: z.string().trim().min(1).max(80),
    policyVersion: z.string().trim().min(1).max(100),
    canonicalPath: repositoryPathSchema.optional(),
    headCommit: z.string().trim().min(1).max(120).optional(),
    errorCode: errorCodeSchema.optional(),
    message: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const executionRepositoryAcceptedPayloadSchema = z
  .object({
    executionId: id,
    projectId: id,
    bindingId: id,
    bindingVersion: z.number().int().min(1),
    policyVersion: z.string().trim().min(1).max(100),
    contextId: id,
    canonicalPath: repositoryPathSchema,
    defaultBranch: repositoryDefaultBranchSchema,
    baseCommit: z.string().trim().min(1).max(120),
    acceptedAt: isoDateTime,
  })
  .strict();

export const executionRepositoryRejectedPayloadSchema = z
  .object({
    executionId: id,
    projectId: id,
    bindingId: id,
    bindingVersion: z.number().int().min(1),
    code: errorCodeSchema,
    message: z.string().trim().min(1).max(2000),
    retryable: z.boolean(),
  })
  .strict();

export const executionStartRejectedPayloadSchema = z
  .object({
    executionId: id,
    code: errorCodeSchema,
    message: z.string().trim().min(1).max(2000),
    retryable: z.boolean(),
  })
  .strict();

export const executionLogReplayUnavailablePayloadSchema = z
  .object({
    executionId: id,
    fromRunnerSeq: z.number().int().min(1),
    throughRunnerSeq: z.number().int().min(1),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.throughRunnerSeq < value.fromRunnerSeq) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['throughRunnerSeq'],
        message: 'throughRunnerSeq must be greater than or equal to fromRunnerSeq',
      });
    }
  });

export const runnerSnapshotExecutionSchema = z
  .object({
    executionId: id,
    phase: executionPhaseSchema,
    lastSeq: z.number().int().min(0),
    startedAt: isoDateTime,
    runtime: z.enum(AGENT_RUNTIMES),
  })
  .strict();

export const runnerSnapshotPayloadSchema = z
  .object({
    executions: z.array(runnerSnapshotExecutionSchema).max(64),
    pendingLogCount: z.number().int().min(0),
  })
  .strict();

export const runnerRegisterMessageSchema = envelope('runner.register', runnerRegisterPayloadSchema);
export const runnerHeartbeatMessageSchema = envelope(
  'runner.heartbeat',
  runnerHeartbeatPayloadSchema,
);
export const executionAcceptedMessageSchema = envelope(
  'execution.accepted',
  executionAcceptedPayloadSchema,
);
export const executionPhaseMessageSchema = envelope('execution.phase', executionPhasePayloadSchema);
export const executionLogMessageSchema = envelope('execution.log', executionLogPayloadSchema);
export const executionProgressMessageSchema = envelope(
  'execution.progress',
  executionProgressPayloadSchema,
);
export const executionCompletedMessageSchema = envelope(
  'execution.completed',
  executionCompletedPayloadSchema,
);
export const executionFailedMessageSchema = envelope(
  'execution.failed',
  executionFailedPayloadSchema,
);
export const executionCancelledMessageSchema = envelope(
  'execution.cancelled',
  executionCancelledPayloadSchema,
);
export const runnerSnapshotMessageSchema = envelope('runner.snapshot', runnerSnapshotPayloadSchema);
export const repositoryValidationMessageSchema = envelope(
  'repository.validation',
  repositoryValidationPayloadSchema,
);
export const executionRepositoryAcceptedMessageSchema = envelope(
  'execution.repository.accepted',
  executionRepositoryAcceptedPayloadSchema,
);
export const executionRepositoryRejectedMessageSchema = envelope(
  'execution.repository.rejected',
  executionRepositoryRejectedPayloadSchema,
);
export const executionStartRejectedMessageSchema = envelope(
  'execution.start.rejected',
  executionStartRejectedPayloadSchema,
);
export const executionLogReplayUnavailableMessageSchema = envelope(
  'execution.log.replay.unavailable',
  executionLogReplayUnavailablePayloadSchema,
);
export const executionTerminalMessageSchema = envelope(
  'execution.terminal',
  executionTerminalPayloadSchema,
);

export const RUNNER_TO_SERVER_MESSAGE_TYPES = [
  'runner.register',
  'runner.heartbeat',
  'execution.accepted',
  'execution.phase',
  'execution.log',
  'execution.progress',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'runner.snapshot',
  'repository.validation',
  'execution.repository.accepted',
  'execution.repository.rejected',
  'execution.start.rejected',
  'execution.log.replay.unavailable',
  'execution.terminal',
] as const;

export const runnerInboundMessageSchema = z.discriminatedUnion('type', [
  runnerRegisterMessageSchema,
  runnerHeartbeatMessageSchema,
  executionAcceptedMessageSchema,
  executionPhaseMessageSchema,
  executionLogMessageSchema,
  executionProgressMessageSchema,
  executionCompletedMessageSchema,
  executionFailedMessageSchema,
  executionCancelledMessageSchema,
  runnerSnapshotMessageSchema,
  repositoryValidationMessageSchema,
  executionRepositoryAcceptedMessageSchema,
  executionRepositoryRejectedMessageSchema,
  executionStartRejectedMessageSchema,
  executionLogReplayUnavailableMessageSchema,
  executionTerminalMessageSchema,
]);

export const runnerServerMessageSchema = z.discriminatedUnion('type', [
  runnerWelcomeMessageSchema,
  runnerErrorMessageSchema,
  executionStartMessageSchema,
  executionCancelMessageSchema,
  executionReconcileMessageSchema,
  executionLogAckMessageSchema,
  repositoryValidateMessageSchema,
  executionRepositoryMessageSchema,
  executionLogResendMessageSchema,
]);

export type RunnerEnvelope = z.infer<typeof runnerEnvelopeBaseSchema>;
type ParsedRunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;
/**
 * Outbound capability declaration. `features` is optional on the wire so an
 * old runner can keep sending the v1 shape, while parsing fills the missing
 * list with `[]` and never infers support for any feature.
 */
export type RunnerCapabilities = Omit<ParsedRunnerCapabilities, 'features'> & {
  features?: RunnerFeature[];
};
export type RunnerRuntimeCapability = z.infer<typeof runnerRuntimeCapabilitySchema>;
export type RunnerLogEntry = z.infer<typeof runnerLogEntrySchema>;
export type GitExecutionResult = z.infer<typeof gitExecutionResultSchema>;
export type RuntimeExecutionOptions = z.infer<typeof runtimeExecutionOptionsSchema>;
export type MissingLogRange = z.infer<typeof missingLogRangeSchema>;
export type TerminalLogCollection = z.infer<typeof terminalLogCollectionSchema>;

export type RunnerHandshake = z.infer<typeof runnerHandshakeSchema>;
export type RunnerWelcomeMessage = z.infer<typeof runnerWelcomeMessageSchema>;
export type RunnerErrorMessage = z.infer<typeof runnerErrorMessageSchema>;
export type ExecutionStartMessage = z.infer<typeof executionStartMessageSchema>;
export type ExecutionCancelMessage = z.infer<typeof executionCancelMessageSchema>;
export type ExecutionReconcileMessage = z.infer<typeof executionReconcileMessageSchema>;
export type ExecutionLogAckMessage = z.infer<typeof executionLogAckMessageSchema>;
export type RepositoryValidateMessage = z.infer<typeof repositoryValidateMessageSchema>;
export type ExecutionRepositoryMessage = z.infer<typeof executionRepositoryMessageSchema>;
export type ExecutionLogResendMessage = z.infer<typeof executionLogResendMessageSchema>;

export type RunnerRegisterMessage = z.infer<typeof runnerRegisterMessageSchema>;
export type RunnerHeartbeatMessage = z.infer<typeof runnerHeartbeatMessageSchema>;
export type ExecutionAcceptedMessage = z.infer<typeof executionAcceptedMessageSchema>;
export type ExecutionPhaseMessage = z.infer<typeof executionPhaseMessageSchema>;
export type ExecutionLogMessage = z.infer<typeof executionLogMessageSchema>;
export type ExecutionProgressMessage = z.infer<typeof executionProgressMessageSchema>;
export type ExecutionCompletedMessage = z.infer<typeof executionCompletedMessageSchema>;
export type ExecutionFailedMessage = z.infer<typeof executionFailedMessageSchema>;
export type ExecutionCancelledMessage = z.infer<typeof executionCancelledMessageSchema>;
export type RunnerSnapshotMessage = z.infer<typeof runnerSnapshotMessageSchema>;
export type RepositoryValidationMessage = z.infer<typeof repositoryValidationMessageSchema>;
export type ExecutionRepositoryAcceptedMessage = z.infer<
  typeof executionRepositoryAcceptedMessageSchema
>;
export type ExecutionRepositoryRejectedMessage = z.infer<
  typeof executionRepositoryRejectedMessageSchema
>;
export type ExecutionStartRejectedMessage = z.infer<typeof executionStartRejectedMessageSchema>;
export type ExecutionLogReplayUnavailableMessage = z.infer<
  typeof executionLogReplayUnavailableMessageSchema
>;
export type ExecutionTerminalMessage = z.infer<typeof executionTerminalMessageSchema>;
export type RunnerInboundMessage = z.infer<typeof runnerInboundMessageSchema>;
export type RunnerServerMessage = z.infer<typeof runnerServerMessageSchema>;

export type RepositoryValidatePayload = z.infer<typeof repositoryValidatePayloadSchema>;
export type RepositoryValidationPayload = z.infer<typeof repositoryValidationPayloadSchema>;
export type ExecutionRepositoryPayload = z.infer<typeof executionRepositoryPayloadSchema>;
export type ExecutionRepositoryAcceptedPayload = z.infer<
  typeof executionRepositoryAcceptedPayloadSchema
>;
export type ExecutionRepositoryRejectedPayload = z.infer<
  typeof executionRepositoryRejectedPayloadSchema
>;
export type ExecutionStartRejectedPayload = z.infer<typeof executionStartRejectedPayloadSchema>;
export type ExecutionLogResendPayload = z.infer<typeof executionLogResendPayloadSchema>;
export type ExecutionLogReplayUnavailablePayload = z.infer<
  typeof executionLogReplayUnavailablePayloadSchema
>;
export type ExecutionTerminalPayload = z.infer<typeof executionTerminalPayloadSchema>;

export function isServerToRunnerMessageType(type: string): boolean {
  return (SERVER_TO_RUNNER_MESSAGE_TYPES as readonly string[]).includes(type);
}

export function isRunnerToServerMessageType(type: string): boolean {
  return (RUNNER_TO_SERVER_MESSAGE_TYPES as readonly string[]).includes(type);
}
