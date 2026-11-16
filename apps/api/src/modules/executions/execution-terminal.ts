import type { Prisma } from '@prisma/client';
import {
  TERMINAL_DECISION_STATUS,
  type ExecutionStatus,
  type TerminalDecision,
} from '@raft-lite/contracts';

type TerminalTx = Prisma.TransactionClient;

export interface TerminalWriteInput {
  executionId: string;
  decision: TerminalDecision;
  /**
   * Stable, non-secret marker of the code path that decided the outcome. It is
   * audit metadata, never user input.
   */
  decidedBy: string;
  endedAt?: Date;
  /** Business fields written in the same conditional update. */
  patch?: Omit<
    Prisma.ExecutionUpdateManyMutationInput,
    'status' | 'phase' | 'dispatchState' | 'terminalDecision' | 'terminalDecidedAt' | 'terminalDecidedBy' | 'endedAt'
  >;
  /** Preserve the "a persisted operator cancel wins" rule for start failures. */
  requireNoCancelIntent?: boolean;
}

/**
 * The single writer for `Execution` row state.
 *
 * It is a conditional update (`status = 'running' AND terminalDecision IS NULL`)
 * so the first terminal writer wins and every later event is a no-op. The
 * database enforces the same invariant with the `Execution_terminal_*` triggers:
 * a terminal row can never be rewritten, and a transition out of `running`
 * without the full terminal tuple aborts.
 *
 * Returns `true` only when this call performed the transition.
 */
export async function writeTerminalDecision(
  tx: TerminalTx,
  input: TerminalWriteInput,
): Promise<boolean> {
  const decidedAt = input.endedAt ?? new Date();
  const status: ExecutionStatus = TERMINAL_DECISION_STATUS[input.decision];
  const result = await tx.execution.updateMany({
    where: {
      id: input.executionId,
      status: 'running',
      terminalDecision: null,
      ...(input.requireNoCancelIntent ? { cancelRequestedAt: null } : {}),
    },
    data: {
      ...input.patch,
      status,
      phase: status,
      dispatchState: 'terminal',
      terminalDecision: input.decision,
      terminalDecidedAt: decidedAt,
      terminalDecidedBy: input.decidedBy,
      endedAt: decidedAt,
    },
  });
  return result.count === 1;
}

/** Mapping for the runtime-driven outcomes. */
export function terminalDecisionForOutcome(
  outcome: 'completed' | 'failed' | 'cancelled',
): TerminalDecision {
  switch (outcome) {
    case 'completed':
      return 'COMPLETED';
    case 'cancelled':
      // Reaching this path already required runner-confirmed process-tree
      // termination (or an execution that never spawned a process at all).
      return 'CANCELLED_CONFIRMED';
    case 'failed':
      return 'EXECUTION_FAILED';
  }
}

/**
 * Mapping for failures observed before `execution.start` was accepted.
 *
 * Only codes that already exist as frozen decisions are mapped; everything else
 * collapses to `EXECUTION_FAILED`. The complete pre-start matrix (disconnect,
 * runner restart, recovery deadline) is Slice 2 work and must not be guessed
 * here.
 */
export function terminalDecisionForStartFailure(code: string | null | undefined): TerminalDecision {
  switch (code) {
    case 'START_ACCEPT_TIMEOUT':
      return 'START_ACCEPT_TIMEOUT';
    case 'RUNNER_START_UNCONFIRMED':
      return 'RUNNER_START_UNCONFIRMED';
    default:
      return 'EXECUTION_FAILED';
  }
}
