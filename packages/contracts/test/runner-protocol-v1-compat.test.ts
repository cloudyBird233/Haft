import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  RUNNER_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  executionCancelledMessageSchema,
  executionCompletedMessageSchema,
  executionFailedMessageSchema,
  executionStartMessageSchema,
  runnerCapabilitiesSchema,
  runnerRegisterMessageSchema,
  type RunnerCapabilities,
} from '../src';

const envelope = {
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  messageId: 'message-1',
  runnerId: 'runner-1',
  sentAt: '2026-11-09T12:00:00.000Z',
};

const legacyStartPayload = {
  executionId: 'execution-1',
  runtime: 'codex',
  taskId: 'task-1',
  taskTitle: 'Ship the baseline',
  taskDescription: 'Keep v1 compatible.',
  projectId: 'project-1',
  prompt: 'Implement the task.',
};

const legacyRegisterPayload = {
  computerId: 'computer-1',
  runnerVersion: '1.0.0',
  platform: 'win32',
  architecture: 'x64',
  capabilities: {
    runtimes: [],
    projectIds: ['project-1'],
    maxConcurrentExecutions: 1,
  },
};

describe('v1 execution.start compatibility', () => {
  it('parses the legacy payload and applies the existing options default', () => {
    const parsed = executionStartMessageSchema.parse({
      ...envelope,
      type: 'execution.start',
      payload: legacyStartPayload,
    });
    expect(parsed.payload.options).toEqual({});
    expect('project' in parsed.payload).toBe(false);
  });

  it('strictly rejects a project path/defaultBranch field on the v1 payload', () => {
    const result = executionStartMessageSchema.safeParse({
      ...envelope,
      type: 'execution.start',
      payload: {
        ...legacyStartPayload,
        project: {
          path: '/srv/repos/haft',
          defaultBranch: 'main',
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('project'))).toBe(true);
    }
  });

  it('strictly rejects any other unknown execution.start field', () => {
    expect(
      executionStartMessageSchema.safeParse({
        ...envelope,
        type: 'execution.start',
        payload: { ...legacyStartPayload, repository: { path: '/srv/repos/haft' } },
      }).success,
    ).toBe(false);
  });
});

describe('legacy terminal message compatibility', () => {
  const legacyTerminalCases: Array<{
    name: string;
    schema: ZodTypeAny;
    payload: Record<string, unknown>;
  }> = [
    {
      name: 'execution.completed',
      schema: executionCompletedMessageSchema,
      payload: { executionId: 'execution-1', exitCode: 0, summary: 'done', git: null },
    },
    {
      name: 'execution.failed',
      schema: executionFailedMessageSchema,
      payload: {
        executionId: 'execution-1',
        reason: 'CLI failed',
        exitCode: 1,
        summary: null,
        git: null,
      },
    },
    {
      name: 'execution.cancelled',
      schema: executionCancelledMessageSchema,
      payload: { executionId: 'execution-1', reason: null, exitCode: null, git: null },
    },
  ];

  it.each(legacyTerminalCases)(
    '$name still parses the legacy payload',
    ({ schema, name, payload }) => {
      expect(schema.safeParse({ ...envelope, type: name, payload }).success).toBe(true);
    },
  );

  it.each(legacyTerminalCases)('$name rejects lastRunnerSeq', ({ schema, name, payload }) => {
    expect(
      schema.safeParse({
        ...envelope,
        type: name,
        payload: { ...payload, lastRunnerSeq: 3 },
      }).success,
    ).toBe(false);
  });

  it('rejects logCollection on the legacy terminal schemas', () => {
    expect(
      executionCompletedMessageSchema.safeParse({
        ...envelope,
        type: 'execution.completed',
        payload: {
          executionId: 'execution-1',
          exitCode: 0,
          summary: 'done',
          git: null,
          logCollection: { status: 'complete' },
        },
      }).success,
    ).toBe(false);
  });
});

describe('old runner registration compatibility', () => {
  it('accepts a registration without capabilities.features', () => {
    const parsed = runnerRegisterMessageSchema.parse({
      ...envelope,
      type: 'runner.register',
      payload: legacyRegisterPayload,
    });
    expect(parsed.payload.capabilities.features).toEqual([]);
  });

  it('parses a capabilities object without features as the empty set', () => {
    const parsed = runnerCapabilitiesSchema.parse({
      runtimes: [],
      projectIds: ['project-1'],
    });
    expect(parsed.features).toEqual([]);
  });

  it('accepts a registration that explicitly declares all features', () => {
    const parsed = runnerRegisterMessageSchema.parse({
      ...envelope,
      type: 'runner.register',
      payload: {
        ...legacyRegisterPayload,
        capabilities: {
          ...legacyRegisterPayload.capabilities,
          features: [...RUNNER_FEATURES],
        },
      },
    });
    expect(parsed.payload.capabilities.features).toEqual([...RUNNER_FEATURES]);
  });

  it('keeps features optional for outbound capability declarations', () => {
    const capabilities: RunnerCapabilities = {
      runtimes: [],
      projectIds: [],
    };
    expect(capabilities.features).toBeUndefined();
  });
});

describe('invalid runner features fail closed', () => {
  const invalidFeatureCases: Array<{ name: string; features: unknown }> = [
    { name: 'unknown feature', features: ['unknown-feature'] },
    { name: 'duplicate feature', features: ['log-replay-v1', 'log-replay-v1'] },
    { name: 'non-string feature', features: [1] },
    { name: 'non-array features', features: 'log-replay-v1' },
  ];

  it.each(invalidFeatureCases)('rejects $name', ({ features }) => {
    const result = runnerCapabilitiesSchema.safeParse({
      runtimes: [],
      projectIds: [],
      features,
    });
    expect(result.success).toBe(false);
  });

  it('rejects more features than the registry can contain', () => {
    const result = runnerCapabilitiesSchema.safeParse({
      runtimes: [],
      projectIds: [],
      features: Array.from({ length: RUNNER_FEATURES.length + 1 }, () => 'log-replay-v1'),
    });
    expect(result.success).toBe(false);
  });
});

describe('protocol version compatibility', () => {
  it('rejects a v2 envelope for an existing v1 message', () => {
    expect(
      executionStartMessageSchema.safeParse({
        ...envelope,
        protocolVersion: 2,
        type: 'execution.start',
        payload: legacyStartPayload,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown envelope fields', () => {
    expect(
      executionStartMessageSchema.safeParse({
        ...envelope,
        type: 'execution.start',
        payload: legacyStartPayload,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
