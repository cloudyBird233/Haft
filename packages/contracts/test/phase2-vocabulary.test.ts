import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_STATUSES,
  ERROR_CODES,
  ERROR_CODE_VALUES,
  EXECUTION_STATUSES,
  LOG_COLLECTION_REASON_CODES,
  LOG_COLLECTION_STATUSES,
  LOG_INTEGRITY_STATUSES,
  RUNNER_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  TERMINAL_OUTCOMES,
  errorCodeSchema,
  runnerFeatureSchema,
  type AcceptanceStatus,
  type ErrorCode,
  type RunnerFeature,
} from '../src';

describe('runner feature registry', () => {
  it('freezes exactly the eight Phase 2 features', () => {
    expect(RUNNER_FEATURES).toEqual([
      'project-binding-v1',
      'repository-validation-v1',
      'repository-path-policy-v1',
      'repository-handshake-v1',
      'log-replay-v1',
      'contiguous-log-ack-v1',
      'terminal-log-barrier-v1',
      'terminal-log-integrity-v1',
    ]);
    expect(new Set(RUNNER_FEATURES).size).toBe(RUNNER_FEATURES.length);
  });

  it('exports a feature type that matches the registry', () => {
    const feature: RunnerFeature = RUNNER_FEATURES[0];
    expect(feature).toBe('project-binding-v1');
  });

  it('accepts every registered feature and rejects anything else', () => {
    for (const feature of RUNNER_FEATURES) {
      expect(runnerFeatureSchema.parse(feature)).toBe(feature);
    }
    expect(runnerFeatureSchema.safeParse('unknown-feature').success).toBe(false);
    expect(runnerFeatureSchema.safeParse('').success).toBe(false);
    expect(runnerFeatureSchema.safeParse(1).success).toBe(false);
  });
});

describe('Phase 2 error code registry', () => {
  it('contains every code required by the frozen P2-00 contract', () => {
    const requiredCodes = [
      'PROJECT_BINDING_UNSUPPORTED',
      'REPOSITORY_HANDSHAKE_TIMEOUT',
      'REPOSITORY_CONTEXT_MISMATCH',
      'REPOSITORY_BINDING_CHANGED',
      'REPOSITORY_POLICY_CHANGED',
      'LOG_BARRIER_TIMEOUT',
      'LOG_RUNNER_SEQ_CONFLICT',
      'LOG_EVENT_ID_CONFLICT',
      'LOG_TERMINAL_LOG_COLLECTION_INVALID',
      'RUNNER_LOG_SPOOL_FAILED',
      'RUNNER_LOG_SPOOL_OVERFLOW',
      'ACTIVE_EXECUTION_RELEASE_SKIPPED',
    ] as const;

    for (const code of requiredCodes) {
      expect(ERROR_CODES).toHaveProperty(code);
    }
  });

  it('keeps a single key/value mapping without duplicates', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
    expect(new Set(ERROR_CODE_VALUES).size).toBe(ERROR_CODE_VALUES.length);
    expect(ERROR_CODE_VALUES).toHaveLength(Object.keys(ERROR_CODES).length);
  });

  it('accepts only registered error codes', () => {
    const code: ErrorCode = ERROR_CODES.LOG_BARRIER_TIMEOUT;
    expect(errorCodeSchema.parse(code)).toBe('LOG_BARRIER_TIMEOUT');
    expect(errorCodeSchema.safeParse('NOT_A_REAL_CODE').success).toBe(false);
    expect(errorCodeSchema.safeParse('log_barrier_timeout').success).toBe(false);
    expect(errorCodeSchema.safeParse('').success).toBe(false);
  });
});

describe('acceptance status vocabulary', () => {
  it('contains the seven engineering acceptance states in order', () => {
    expect(ACCEPTANCE_STATUSES).toEqual([
      'PASS',
      'FAIL',
      'BLOCKED',
      'PARTIAL',
      'NOT_VERIFIED',
      'SKIPPED',
      'INCONCLUSIVE',
    ]);
    expect(new Set(ACCEPTANCE_STATUSES).size).toBe(7);
  });

  it('does not leak acceptance states into the product execution state machine', () => {
    const acceptance: AcceptanceStatus = 'PASS';
    expect(acceptance).toBe('PASS');
    for (const status of ACCEPTANCE_STATUSES) {
      expect(EXECUTION_STATUSES as readonly string[]).not.toContain(status);
    }
  });
});

describe('terminal and log collection vocabulary', () => {
  it('freezes terminal outcomes to the three v1 execution outcomes', () => {
    expect(TERMINAL_OUTCOMES).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('allows only complete or incomplete collection statuses', () => {
    expect(LOG_COLLECTION_STATUSES).toEqual(['complete', 'incomplete']);
  });

  it('derives the incomplete reason codes from the error registry', () => {
    expect(LOG_COLLECTION_REASON_CODES).toEqual([
      'RUNNER_LOG_SPOOL_FAILED',
      'RUNNER_LOG_SPOOL_OVERFLOW',
      'RUNNER_LOG_SEQ_GAP',
      'RUNNER_LOG_COLLECTION_ABORTED',
    ]);
  });

  it('keeps unknown as an explicit log integrity status', () => {
    expect(LOG_INTEGRITY_STATUSES).toEqual([
      'unknown',
      'complete',
      'incomplete',
      'legacy_inferred',
    ]);
  });

  it('keeps the protocol version at v1', () => {
    expect(RUNNER_PROTOCOL_VERSION).toBe(1);
  });
});
