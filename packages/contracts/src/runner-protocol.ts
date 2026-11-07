import { z } from 'zod';
import {
  AGENT_RUNTIMES,
  EXECUTION_DIFF_MAX_BYTES,
  EXECUTION_PHASES,
  LOG_LEVELS,
  LOG_STREAMS,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_RUNTIMES,
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

export const runnerRuntimeSchema = z.enum(RUNNER_RUNTIMES);
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

export const runnerCapabilitiesSchema = z
  .object({
    runtimes: z.array(runnerRuntimeCapabilitySchema).max(10),
    projectIds: z.array(id).max(200),
    maxConcurrentExecutions: z.number().int().min(1).max(32).nullable().optional(),
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
    timeoutMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
  })
  .strict();

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

export const runnerWelcomeMessageSchema = envelope(
  'runner.welcome',
  runnerWelcomePayloadSchema,
);
export const runnerErrorMessageSchema = envelope('runner.error', runnerErrorPayloadSchema);
export const executionStartMessageSchema = envelope(
  'execution.start',
  executionStartPayloadSchema,
);
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

export const SERVER_TO_RUNNER_MESSAGE_TYPES = [
  'runner.welcome',
  'runner.error',
  'execution.start',
  'execution.cancel',
  'execution.reconcile',
  'execution.log.ack',
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

export const runnerRegisterMessageSchema = envelope(
  'runner.register',
  runnerRegisterPayloadSchema,
);
export const runnerHeartbeatMessageSchema = envelope(
  'runner.heartbeat',
  runnerHeartbeatPayloadSchema,
);
export const executionAcceptedMessageSchema = envelope(
  'execution.accepted',
  executionAcceptedPayloadSchema,
);
export const executionPhaseMessageSchema = envelope(
  'execution.phase',
  executionPhasePayloadSchema,
);
export const executionLogMessageSchema = envelope(
  'execution.log',
  executionLogPayloadSchema,
);
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
export const runnerSnapshotMessageSchema = envelope(
  'runner.snapshot',
  runnerSnapshotPayloadSchema,
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
]);

export const runnerServerMessageSchema = z.discriminatedUnion('type', [
  runnerWelcomeMessageSchema,
  runnerErrorMessageSchema,
  executionStartMessageSchema,
  executionCancelMessageSchema,
  executionReconcileMessageSchema,
  executionLogAckMessageSchema,
]);

export type RunnerEnvelope = z.infer<typeof runnerEnvelopeBaseSchema>;
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;
export type RunnerRuntimeCapability = z.infer<typeof runnerRuntimeCapabilitySchema>;
export type RunnerLogEntry = z.infer<typeof runnerLogEntrySchema>;
export type GitExecutionResult = z.infer<typeof gitExecutionResultSchema>;
export type RuntimeExecutionOptions = z.infer<typeof runtimeExecutionOptionsSchema>;

export type RunnerHandshake = z.infer<typeof runnerHandshakeSchema>;
export type RunnerWelcomeMessage = z.infer<typeof runnerWelcomeMessageSchema>;
export type RunnerErrorMessage = z.infer<typeof runnerErrorMessageSchema>;
export type ExecutionStartMessage = z.infer<typeof executionStartMessageSchema>;
export type ExecutionCancelMessage = z.infer<typeof executionCancelMessageSchema>;
export type ExecutionReconcileMessage = z.infer<typeof executionReconcileMessageSchema>;
export type ExecutionLogAckMessage = z.infer<typeof executionLogAckMessageSchema>;

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
export type RunnerInboundMessage = z.infer<typeof runnerInboundMessageSchema>;
export type RunnerServerMessage = z.infer<typeof runnerServerMessageSchema>;

export function isServerToRunnerMessageType(type: string): boolean {
  return (SERVER_TO_RUNNER_MESSAGE_TYPES as readonly string[]).includes(type);
}

export function isRunnerToServerMessageType(type: string): boolean {
  return (RUNNER_TO_SERVER_MESSAGE_TYPES as readonly string[]).includes(type);
}
