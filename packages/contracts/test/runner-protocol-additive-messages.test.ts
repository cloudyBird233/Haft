import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  RUNNER_PROTOCOL_VERSION,
  RUNNER_TO_SERVER_MESSAGE_TYPES,
  SERVER_TO_RUNNER_MESSAGE_TYPES,
  executionLogReplayUnavailableMessageSchema,
  executionLogResendMessageSchema,
  executionRepositoryAcceptedMessageSchema,
  executionRepositoryMessageSchema,
  executionRepositoryRejectedMessageSchema,
  executionStartRejectedMessageSchema,
  executionTerminalMessageSchema,
  isRunnerToServerMessageType,
  isServerToRunnerMessageType,
  repositoryDefaultBranchSchema,
  repositoryPathSchema,
  repositoryValidateMessageSchema,
  repositoryValidationMessageSchema,
  runnerInboundMessageSchema,
  runnerServerMessageSchema,
} from '../src';

const envelope = {
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  messageId: 'message-1',
  runnerId: 'runner-1',
  sentAt: '2026-11-09T12:00:00.000Z',
};

const acceptedAt = '2026-11-09T12:00:01.000Z';
const policyVersion = '0123456789abcdef';
const baseCommit = 'a'.repeat(40);

interface MessageCase {
  name: string;
  schema: ZodTypeAny;
  message: Record<string, unknown>;
  omitPayloadField: string;
}

const serverCases: MessageCase[] = [
  {
    name: 'repository.validate',
    schema: repositoryValidateMessageSchema,
    message: {
      ...envelope,
      type: 'repository.validate',
      payload: {
        requestId: 'request-1',
        projectId: 'project-1',
        computerId: 'computer-1',
        bindingId: 'binding-1',
        bindingVersion: 1,
        path: '/srv/repos/haft',
      },
    },
    omitPayloadField: 'path',
  },
  {
    name: 'execution.repository',
    schema: executionRepositoryMessageSchema,
    message: {
      ...envelope,
      type: 'execution.repository',
      payload: {
        executionId: 'execution-1',
        projectId: 'project-1',
        bindingId: 'binding-1',
        bindingVersion: 1,
        path: '/srv/repos/haft',
        defaultBranch: 'main',
        policyVersion,
      },
    },
    omitPayloadField: 'bindingId',
  },
  {
    name: 'execution.log.resend',
    schema: executionLogResendMessageSchema,
    message: {
      ...envelope,
      type: 'execution.log.resend',
      payload: {
        executionId: 'execution-1',
        fromRunnerSeq: 2,
        toRunnerSeq: 4,
      },
    },
    omitPayloadField: 'fromRunnerSeq',
  },
];

const runnerCases: MessageCase[] = [
  {
    name: 'repository.validation',
    schema: repositoryValidationMessageSchema,
    message: {
      ...envelope,
      type: 'repository.validation',
      payload: {
        requestId: 'request-1',
        projectId: 'project-1',
        computerId: 'computer-1',
        bindingId: 'binding-1',
        bindingVersion: 1,
        ok: true,
        platform: 'linux',
        policyVersion,
        canonicalPath: '/srv/repos/haft',
        headCommit: baseCommit,
      },
    },
    omitPayloadField: 'requestId',
  },
  {
    name: 'execution.repository.accepted',
    schema: executionRepositoryAcceptedMessageSchema,
    message: {
      ...envelope,
      type: 'execution.repository.accepted',
      payload: {
        executionId: 'execution-1',
        projectId: 'project-1',
        bindingId: 'binding-1',
        bindingVersion: 1,
        policyVersion,
        contextId: 'context-1',
        canonicalPath: '/srv/repos/haft',
        defaultBranch: 'main',
        baseCommit,
        acceptedAt,
      },
    },
    omitPayloadField: 'contextId',
  },
  {
    name: 'execution.repository.rejected',
    schema: executionRepositoryRejectedMessageSchema,
    message: {
      ...envelope,
      type: 'execution.repository.rejected',
      payload: {
        executionId: 'execution-1',
        projectId: 'project-1',
        bindingId: 'binding-1',
        bindingVersion: 1,
        code: 'REPO_DEFAULT_BRANCH_NOT_FOUND',
        message: 'The default branch does not exist in this repository.',
        retryable: false,
      },
    },
    omitPayloadField: 'code',
  },
  {
    name: 'execution.start.rejected',
    schema: executionStartRejectedMessageSchema,
    message: {
      ...envelope,
      type: 'execution.start.rejected',
      payload: {
        executionId: 'execution-1',
        code: 'REPOSITORY_CONTEXT_NOT_READY',
        message: 'No prepared repository context exists for this execution.',
        retryable: true,
      },
    },
    omitPayloadField: 'retryable',
  },
  {
    name: 'execution.log.replay.unavailable',
    schema: executionLogReplayUnavailableMessageSchema,
    message: {
      ...envelope,
      type: 'execution.log.replay.unavailable',
      payload: {
        executionId: 'execution-1',
        fromRunnerSeq: 2,
        throughRunnerSeq: 5,
        reason: 'The spool entries were already trimmed.',
      },
    },
    omitPayloadField: 'reason',
  },
  {
    name: 'execution.terminal',
    schema: executionTerminalMessageSchema,
    message: {
      ...envelope,
      type: 'execution.terminal',
      payload: {
        executionId: 'execution-1',
        outcome: 'completed',
        lastRunnerSeq: 3,
        logCollection: {
          status: 'complete',
          allocatedThroughRunnerSeq: 3,
          appendedThroughRunnerSeq: 3,
        },
        exitCode: 0,
        summary: 'done',
        git: null,
      },
    },
    omitPayloadField: 'lastRunnerSeq',
  },
];

function withoutPayloadField(
  message: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const payload = message.payload as Record<string, unknown>;
  const invalidPayload = { ...payload };
  delete invalidPayload[field];
  return { ...message, payload: invalidPayload };
}

describe('Server -> Runner additive messages', () => {
  it.each(serverCases)('$name parses in the server-to-runner direction', ({ schema, message }) => {
    expect(schema.safeParse(message).success).toBe(true);
    expect(runnerServerMessageSchema.safeParse(message).success).toBe(true);
    expect(runnerInboundMessageSchema.safeParse(message).success).toBe(false);
  });

  it.each(serverCases)(
    '$name rejects a missing required payload field',
    ({ schema, message, omitPayloadField }) => {
      expect(schema.safeParse(withoutPayloadField(message, omitPayloadField)).success).toBe(false);
    },
  );

  it.each(serverCases)('$name rejects unknown payload fields', ({ schema, message }) => {
    const payload = message.payload as Record<string, unknown>;
    expect(schema.safeParse({ ...message, payload: { ...payload, extra: true } }).success).toBe(
      false,
    );
  });

  it.each(serverCases)('$name rejects an unknown envelope field', ({ message }) => {
    expect(runnerServerMessageSchema.safeParse({ ...message, extraEnvelope: true }).success).toBe(
      false,
    );
  });
});

describe('Runner -> Server additive messages', () => {
  it.each(runnerCases)('$name parses in the runner-to-server direction', ({ schema, message }) => {
    expect(schema.safeParse(message).success).toBe(true);
    expect(runnerInboundMessageSchema.safeParse(message).success).toBe(true);
    expect(runnerServerMessageSchema.safeParse(message).success).toBe(false);
  });

  it.each(runnerCases)(
    '$name rejects a missing required payload field',
    ({ schema, message, omitPayloadField }) => {
      expect(schema.safeParse(withoutPayloadField(message, omitPayloadField)).success).toBe(false);
    },
  );

  it.each(runnerCases)('$name rejects unknown payload fields', ({ schema, message }) => {
    const payload = message.payload as Record<string, unknown>;
    expect(schema.safeParse({ ...message, payload: { ...payload, extra: true } }).success).toBe(
      false,
    );
  });

  it.each(runnerCases)('$name rejects an unknown envelope field', ({ message }) => {
    expect(runnerInboundMessageSchema.safeParse({ ...message, extraEnvelope: true }).success).toBe(
      false,
    );
  });
});

describe('message direction registry', () => {
  it('contains every new message exactly once in the right direction', () => {
    for (const { name } of serverCases) {
      expect(SERVER_TO_RUNNER_MESSAGE_TYPES as readonly string[]).toContain(name);
      expect(RUNNER_TO_SERVER_MESSAGE_TYPES as readonly string[]).not.toContain(name);
      expect(isServerToRunnerMessageType(name)).toBe(true);
      expect(isRunnerToServerMessageType(name)).toBe(false);
    }
    for (const { name } of runnerCases) {
      expect(RUNNER_TO_SERVER_MESSAGE_TYPES as readonly string[]).toContain(name);
      expect(SERVER_TO_RUNNER_MESSAGE_TYPES as readonly string[]).not.toContain(name);
      expect(isRunnerToServerMessageType(name)).toBe(true);
      expect(isServerToRunnerMessageType(name)).toBe(false);
    }
  });

  it('keeps the two direction registries disjoint and duplicate-free', () => {
    expect(new Set(SERVER_TO_RUNNER_MESSAGE_TYPES).size).toBe(
      SERVER_TO_RUNNER_MESSAGE_TYPES.length,
    );
    expect(new Set(RUNNER_TO_SERVER_MESSAGE_TYPES).size).toBe(
      RUNNER_TO_SERVER_MESSAGE_TYPES.length,
    );
    const overlap = SERVER_TO_RUNNER_MESSAGE_TYPES.filter((type) =>
      (RUNNER_TO_SERVER_MESSAGE_TYPES as readonly string[]).includes(type),
    );
    expect(overlap).toEqual([]);
  });
});

describe('message boundary validation', () => {
  const validRepositoryValidate = serverCases[0]!.message;

  it('accepts a 120 character messageId and rejects 121 characters', () => {
    expect(
      repositoryValidateMessageSchema.safeParse({
        ...validRepositoryValidate,
        messageId: 'm'.repeat(120),
      }).success,
    ).toBe(true);
    expect(
      repositoryValidateMessageSchema.safeParse({
        ...validRepositoryValidate,
        messageId: 'm'.repeat(121),
      }).success,
    ).toBe(false);
  });

  it('accepts bindingVersion 1 and rejects zero or non-integers', () => {
    const payload = validRepositoryValidate.payload as Record<string, unknown>;
    expect(
      repositoryValidateMessageSchema.safeParse({
        ...validRepositoryValidate,
        payload: { ...payload, bindingVersion: 1 },
      }).success,
    ).toBe(true);
    expect(
      repositoryValidateMessageSchema.safeParse({
        ...validRepositoryValidate,
        payload: { ...payload, bindingVersion: 0 },
      }).success,
    ).toBe(false);
    expect(
      repositoryValidateMessageSchema.safeParse({
        ...validRepositoryValidate,
        payload: { ...payload, bindingVersion: 1.5 },
      }).success,
    ).toBe(false);
  });

  it('accepts a 4096 character repository path and rejects 4097 characters or NUL', () => {
    const longPath = `/${'a'.repeat(4095)}`;
    expect(longPath).toHaveLength(4096);
    expect(repositoryPathSchema.safeParse(longPath).success).toBe(true);
    expect(repositoryPathSchema.safeParse(`${longPath}a`).success).toBe(false);
    expect(repositoryPathSchema.safeParse('/srv/repos/ha\0ft').success).toBe(false);
  });

  it('rejects relative-only validation for the path policy layer left to P2-02', () => {
    // The wire contract accepts the path shape; absolute/realpath enforcement
    // is intentionally not duplicated here.
    expect(repositoryPathSchema.safeParse('relative/repo').success).toBe(true);
  });

  it('validates the default branch contract', () => {
    for (const branch of ['main', 'release/2.0', 'feature/p2-00_baseline']) {
      expect(repositoryDefaultBranchSchema.safeParse(branch).success).toBe(true);
    }
    for (const branch of [
      '',
      ' main',
      'ma in',
      'ma\tin',
      'main\n',
      '-main',
      'release..2.0',
      'HEAD',
    ]) {
      expect(repositoryDefaultBranchSchema.safeParse(branch).success).toBe(false);
    }
  });

  it('rejects an inverted execution.log.resend range', () => {
    const message = serverCases[2]!.message;
    const payload = message.payload as Record<string, unknown>;
    expect(
      executionLogResendMessageSchema.safeParse({
        ...message,
        payload: { ...payload, fromRunnerSeq: 5, toRunnerSeq: 4 },
      }).success,
    ).toBe(false);
  });

  it('allows execution.log.resend without an upper bound', () => {
    const message = serverCases[2]!.message;
    const payload = message.payload as Record<string, unknown>;
    const { toRunnerSeq: _toRunnerSeq, ...unbounded } = payload;
    expect(
      executionLogResendMessageSchema.safeParse({ ...message, payload: unbounded }).success,
    ).toBe(true);
  });

  it('rejects an inverted execution.log.replay.unavailable range', () => {
    const message = runnerCases[4]!.message;
    const payload = message.payload as Record<string, unknown>;
    expect(
      executionLogReplayUnavailableMessageSchema.safeParse({
        ...message,
        payload: { ...payload, fromRunnerSeq: 5, throughRunnerSeq: 4 },
      }).success,
    ).toBe(false);
  });

  it('accepts lastRunnerSeq 0 with an empty complete collection', () => {
    const message = runnerCases[5]!.message;
    const payload = message.payload as Record<string, unknown>;
    expect(
      executionTerminalMessageSchema.safeParse({
        ...message,
        payload: {
          ...payload,
          lastRunnerSeq: 0,
          logCollection: {
            status: 'complete',
            allocatedThroughRunnerSeq: 0,
            appendedThroughRunnerSeq: 0,
          },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a negative lastRunnerSeq', () => {
    const message = runnerCases[5]!.message;
    const payload = message.payload as Record<string, unknown>;
    expect(
      executionTerminalMessageSchema.safeParse({
        ...message,
        payload: { ...payload, lastRunnerSeq: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('execution.terminal logCollection integrity', () => {
  const terminalMessage = runnerCases[5]!.message;
  const terminalPayload = terminalMessage.payload as Record<string, unknown>;

  it('parses a complete collection', () => {
    const parsed = executionTerminalMessageSchema.safeParse(terminalMessage);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.logCollection?.status).toBe('complete');
      expect(parsed.data.payload.logCollection?.reasonCode).toBeUndefined();
    }
  });

  it('leaves a missing logCollection undefined instead of defaulting to complete', () => {
    const { logCollection: _logCollection, ...payload } = terminalPayload;
    const parsed = executionTerminalMessageSchema.safeParse({
      ...terminalMessage,
      payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.logCollection).toBeUndefined();
      expect(parsed.data.payload.logCollection?.status ?? 'unknown').toBe('unknown');
    }
  });

  it('rejects an unknown collection status', () => {
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          logCollection: {
            status: 'unknown',
            allocatedThroughRunnerSeq: 3,
            appendedThroughRunnerSeq: 3,
          },
        },
      }).success,
    ).toBe(false);
  });

  it('requires a reasonCode when the collection is incomplete', () => {
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          lastRunnerSeq: 3,
          logCollection: {
            status: 'incomplete',
            allocatedThroughRunnerSeq: 5,
            appendedThroughRunnerSeq: 5,
            missingRanges: [{ fromRunnerSeq: 4, toRunnerSeq: 4 }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('preserves the reasonCode and missing ranges for an incomplete collection', () => {
    const parsed = executionTerminalMessageSchema.safeParse({
      ...terminalMessage,
      payload: {
        ...terminalPayload,
        outcome: 'failed',
        lastRunnerSeq: 3,
        logCollection: {
          status: 'incomplete',
          reasonCode: 'RUNNER_LOG_SPOOL_FAILED',
          allocatedThroughRunnerSeq: 5,
          appendedThroughRunnerSeq: 5,
          missingRanges: [{ fromRunnerSeq: 4, toRunnerSeq: 4 }],
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.logCollection).toEqual({
        status: 'incomplete',
        reasonCode: 'RUNNER_LOG_SPOOL_FAILED',
        allocatedThroughRunnerSeq: 5,
        appendedThroughRunnerSeq: 5,
        missingRanges: [{ fromRunnerSeq: 4, toRunnerSeq: 4 }],
      });
    }
  });

  it('rejects a complete collection with mismatched counters', () => {
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          lastRunnerSeq: 2,
          logCollection: {
            status: 'complete',
            allocatedThroughRunnerSeq: 3,
            appendedThroughRunnerSeq: 3,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          logCollection: {
            status: 'complete',
            allocatedThroughRunnerSeq: 4,
            appendedThroughRunnerSeq: 3,
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a complete collection with missing ranges', () => {
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          logCollection: {
            status: 'complete',
            allocatedThroughRunnerSeq: 3,
            appendedThroughRunnerSeq: 3,
            missingRanges: [{ fromRunnerSeq: 4, toRunnerSeq: 4 }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects lastRunnerSeq above the appended prefix', () => {
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          lastRunnerSeq: 4,
          logCollection: {
            status: 'incomplete',
            reasonCode: 'RUNNER_LOG_SPOOL_OVERFLOW',
            allocatedThroughRunnerSeq: 4,
            appendedThroughRunnerSeq: 3,
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a missing range inside the contiguous prefix', () => {
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          lastRunnerSeq: 3,
          logCollection: {
            status: 'incomplete',
            reasonCode: 'RUNNER_LOG_SEQ_GAP',
            allocatedThroughRunnerSeq: 4,
            appendedThroughRunnerSeq: 4,
            missingRanges: [{ fromRunnerSeq: 2, toRunnerSeq: 2 }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a missing range beyond the appended prefix', () => {
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: {
          ...terminalPayload,
          lastRunnerSeq: 3,
          logCollection: {
            status: 'incomplete',
            reasonCode: 'RUNNER_LOG_SEQ_GAP',
            allocatedThroughRunnerSeq: 6,
            appendedThroughRunnerSeq: 5,
            missingRanges: [{ fromRunnerSeq: 6, toRunnerSeq: 6 }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unsorted or overlapping missing ranges', () => {
    const invalidRanges = [
      [
        { fromRunnerSeq: 5, toRunnerSeq: 5 },
        { fromRunnerSeq: 4, toRunnerSeq: 4 },
      ],
      [
        { fromRunnerSeq: 4, toRunnerSeq: 5 },
        { fromRunnerSeq: 5, toRunnerSeq: 6 },
      ],
      [{ fromRunnerSeq: 5, toRunnerSeq: 4 }],
    ];
    for (const missingRanges of invalidRanges) {
      expect(
        executionTerminalMessageSchema.safeParse({
          ...terminalMessage,
          payload: {
            ...terminalPayload,
            lastRunnerSeq: 3,
            logCollection: {
              status: 'incomplete',
              reasonCode: 'RUNNER_LOG_SEQ_GAP',
              allocatedThroughRunnerSeq: 6,
              appendedThroughRunnerSeq: 6,
              missingRanges,
            },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('rejects an incomplete collection without allocated/appended counters', () => {
    const payload = terminalPayload.logCollection as Record<string, unknown>;
    const { allocatedThroughRunnerSeq: _allocated, ...collectionWithoutAllocated } = payload;
    expect(
      executionTerminalMessageSchema.safeParse({
        ...terminalMessage,
        payload: { ...terminalPayload, logCollection: collectionWithoutAllocated },
      }).success,
    ).toBe(false);
  });
});
