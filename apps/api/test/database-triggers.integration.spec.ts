import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupTempDatabases,
  createMigratedDatabase,
  type TempDatabase,
} from './support/migration-cli';

/**
 * Acceptance C: every trigger must reject its invariant violation from inside
 * SQLite (the error text is the `RAISE` message), accept a legal operation, and
 * leave the row untouched when it aborts.
 */

interface L2Contract {
  terminalDecisions: string[];
  terminalDecisionStatus: Record<string, string>;
  terminalStatuses: string[];
  terminalDecidedBy: { prefixes: string[]; identities: string[] };
  executionRegistrationAudit: { columns: string[]; decisions: string[] };
}

const L2: L2Contract = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'l2-v1.1-contract.json'), 'utf8'),
) as L2Contract;

const SHA = 'a'.repeat(64);

/**
 * Prisma stores SQLite `DateTime` as an INTEGER number of Unix milliseconds, so
 * the terminal-tuple triggers require exactly that shape. `CURRENT_TIMESTAMP`
 * would be a TEXT value and is deliberately rejected by T1/T3.
 */
const NOW_MS_SQL = `CAST(strftime('%s','now') AS INTEGER) * 1000`;
const LEGAL_DECIDED_BY = 'API:terminal-event';

function decisionForStatus(status: string): string {
  if (status === 'completed') {
    return 'COMPLETED';
  }
  if (status === 'cancelled') {
    return 'CANCELLED_CONFIRMED';
  }
  return 'EXECUTION_FAILED';
}

let database: TempDatabase;
let prisma: PrismaClient;
let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

async function exec(sql: string): Promise<number> {
  return prisma.$executeRawUnsafe(sql);
}

async function expectAbort(sql: string, pattern: RegExp): Promise<void> {
  await expect(exec(sql)).rejects.toThrow(pattern);
}

/** Minimal valid graph: workspace -> project -> agent -> task (+ runner). */
async function createExecutionFixture(
  options: {
    status?: string;
    dispatchState?: string;
    terminal?: boolean;
  } = {},
): Promise<string> {
  const workspaceId = nextId('ws');
  const projectId = nextId('pj');
  const agentId = nextId('ag');
  const taskId = nextId('tk');
  const executionId = nextId('ex');
  await exec(
    `INSERT INTO "Workspace" (id, name, slug, createdAt, updatedAt) VALUES ('${workspaceId}', 'W', '${workspaceId}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await exec(
    `INSERT INTO "Project" (id, workspaceId, key, name, description, color, defaultBranch, createdAt, updatedAt)
     VALUES ('${projectId}', '${workspaceId}', '${projectId}', 'P', '', '#000000', 'main', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await exec(
    `INSERT INTO "Agent" (id, workspaceId, name, role, description, runtime, status, createdAt, updatedAt)
     VALUES ('${agentId}', '${workspaceId}', 'A', 'dev', '', 'mock', 'idle', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await exec(
    `INSERT INTO "Task" (id, workspaceId, projectId, title, description, priority, status, createdAt, updatedAt)
     VALUES ('${taskId}', '${workspaceId}', '${projectId}', 'T', '', 'medium', 'todo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );

  const status = options.status ?? 'running';
  const dispatchState = options.dispatchState ?? 'created';
  if (options.terminal) {
    await exec(
      `INSERT INTO "Execution" (id, taskId, agentId, status, phase, dispatchState, endedAt, terminalDecision, terminalDecidedAt, terminalDecidedBy, createdAt, updatedAt)
       VALUES ('${executionId}', '${taskId}', '${agentId}', '${status}', '${status}', '${dispatchState}', CURRENT_TIMESTAMP, '${decisionForStatus(status)}', ${NOW_MS_SQL}, '${LEGAL_DECIDED_BY}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
  } else {
    await exec(
      `INSERT INTO "Execution" (id, taskId, agentId, status, phase, dispatchState, createdAt, updatedAt)
       VALUES ('${executionId}', '${taskId}', '${agentId}', '${status}', '${status}', '${dispatchState}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
  }
  return executionId;
}

async function insertMessage(
  executionId: string,
  options: {
    messageType?: string;
    messageId?: string;
    status?: string;
    payloadHash?: string;
    attempt?: number;
    lastReplayedAt?: string | null;
    sentAt?: string | null;
    ackedAt?: string | null;
  } = {},
): Promise<string> {
  const messageId = options.messageId ?? nextId('msg');
  const messageType = options.messageType ?? 'execution.repository';
  const status = options.status ?? 'created';
  const payloadHash = options.payloadHash ?? SHA;
  const attempt = options.attempt ?? 1;
  const sentAt = options.sentAt === undefined ? null : options.sentAt;
  const ackedAt = options.ackedAt === undefined ? null : options.ackedAt;
  const lastReplayedAt = options.lastReplayedAt === undefined ? null : options.lastReplayedAt;
  await exec(
    `INSERT INTO "RepositoryHandshakeMessage"
       (id, executionId, runnerId, messageType, messageId, protocolVersion, attempt, envelopeJson, payloadHash,
        canonicalizationVersion, createdRegistrationId, createdRegistrationEpoch, status, sentAt, ackedAt, lastReplayedAt, createdAt, updatedAt)
     VALUES ('${nextId('hm')}', '${executionId}', 'rn_fixture', '${messageType}', '${messageId}', 1, ${attempt},
        '{"type":"${messageType}"}', '${payloadHash}', 'haft-jcs-1', 'reg-1', 1, '${status}',
        ${sentAt ? `'${sentAt}'` : 'NULL'}, ${ackedAt ? `'${ackedAt}'` : 'NULL'},
        ${lastReplayedAt ? `'${lastReplayedAt}'` : 'NULL'},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  return messageId;
}

async function executionRow(id: string): Promise<{
  status: string;
  phase: string;
  dispatchState: string;
  terminalDecision: string | null;
  terminalDecidedAt: unknown;
  terminalDecidedBy: string | null;
  endedAt: unknown;
  startSentAt: unknown;
  recoveryDeadlineAt: unknown;
}> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      status: string;
      phase: string;
      dispatchState: string;
      terminalDecision: string | null;
      terminalDecidedAt: unknown;
      terminalDecidedBy: string | null;
      endedAt: unknown;
      startSentAt: unknown;
      recoveryDeadlineAt: unknown;
    }>
  >(
    `SELECT status, phase, dispatchState, terminalDecision, terminalDecidedAt, terminalDecidedBy, endedAt, startSentAt, recoveryDeadlineAt FROM "Execution" WHERE id = '${id}'`,
  );
  return rows[0]!;
}

/** Minimal graph shared by the decision / tuple matrix. */
async function createGraph(): Promise<{ taskId: string; agentId: string }> {
  const workspaceId = nextId('ws');
  const projectId = nextId('pj');
  const agentId = nextId('ag');
  const taskId = nextId('tk');
  await exec(
    `INSERT INTO "Workspace" (id, name, slug, createdAt, updatedAt) VALUES ('${workspaceId}', 'W', '${workspaceId}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await exec(
    `INSERT INTO "Project" (id, workspaceId, key, name, description, color, defaultBranch, createdAt, updatedAt)
     VALUES ('${projectId}', '${workspaceId}', '${projectId}', 'P', '', '#000000', 'main', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await exec(
    `INSERT INTO "Agent" (id, workspaceId, name, role, description, runtime, status, createdAt, updatedAt)
     VALUES ('${agentId}', '${workspaceId}', 'A', 'dev', '', 'mock', 'idle', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await exec(
    `INSERT INTO "Task" (id, workspaceId, projectId, title, description, priority, status, createdAt, updatedAt)
     VALUES ('${taskId}', '${workspaceId}', '${projectId}', 'T', '', 'medium', 'todo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  return { taskId, agentId };
}

interface RawExecutionOptions {
  status?: string;
  phase?: string;
  dispatchState?: string;
  /** SQL expression, e.g. `NOW_MS_SQL`, `'0'`, `'1.5'`, `NULL`. */
  endedAt?: string;
  /** SQL expression or quoted literal. */
  decision?: string;
  /** SQL expression or quoted literal. */
  decidedAt?: string;
  /** SQL expression or quoted literal. */
  decidedBy?: string;
}

/** Inserts an execution with every column spelled out so each invariant can be isolated. */
async function insertExecutionRaw(
  graph: { taskId: string; agentId: string },
  options: RawExecutionOptions = {},
): Promise<string> {
  const id = nextId('ex');
  const status = options.status ?? 'running';
  const terminal = status !== 'running';
  const phase = options.phase ?? status;
  const dispatchState = options.dispatchState ?? (terminal ? 'terminal' : 'created');
  const endedAt = options.endedAt ?? (terminal ? 'CURRENT_TIMESTAMP' : 'NULL');
  const decision = options.decision ?? (terminal ? `'${decisionForStatus(status)}'` : 'NULL');
  const decidedAt = options.decidedAt ?? (terminal ? NOW_MS_SQL : 'NULL');
  const decidedBy = options.decidedBy ?? (terminal ? `'${LEGAL_DECIDED_BY}'` : 'NULL');
  await exec(
    `INSERT INTO "Execution"
       (id, taskId, agentId, status, phase, dispatchState, endedAt, terminalDecision, terminalDecidedAt, terminalDecidedBy, createdAt, updatedAt)
     VALUES ('${id}', '${graph.taskId}', '${graph.agentId}', '${status}', '${phase}', '${dispatchState}',
       ${endedAt}, ${decision}, ${decidedAt}, ${decidedBy}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  return id;
}

beforeAll(async () => {
  database = createMigratedDatabase({ label: 'slice1-triggers' });
  prisma = new PrismaClient({ datasources: { db: { url: database.url } } });
  await prisma.$connect();
  await exec(
    `INSERT INTO "Computer" (id, name, hostname, status, createdAt, updatedAt)
     VALUES ('cp_fixture', 'C', 'c', 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  await exec(
    `INSERT INTO "Runner" (id, computerId, tokenHash, protocolVersion, runnerVersion, platform, architecture, status, capabilitiesJson, maxConcurrentExecutions, createdAt, updatedAt)
     VALUES ('rn_fixture', 'cp_fixture', 'hash', 1, '0.1.0', 'win32', 'x64', 'online', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
}, 120_000);

beforeEach(() => {
  // Each test creates its own graph; nothing is shared except the runner.
});

afterAll(async () => {
  await prisma?.$disconnect();
  cleanupTempDatabases();
});

describe('T1 Execution_terminal_insert_guard', () => {
  it('accepts a running insert', async () => {
    await expect(createExecutionFixture()).resolves.toBeTruthy();
  });

  it('rejects a terminal insert without the terminal tuple', async () => {
    const workspaceId = nextId('ws');
    const projectId = nextId('pj');
    const agentId = nextId('ag');
    const taskId = nextId('tk');
    await exec(
      `INSERT INTO "Workspace" (id, name, slug, createdAt, updatedAt) VALUES ('${workspaceId}', 'W', '${workspaceId}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await exec(
      `INSERT INTO "Project" (id, workspaceId, key, name, description, color, defaultBranch, createdAt, updatedAt)
       VALUES ('${projectId}', '${workspaceId}', '${projectId}', 'P', '', '#000000', 'main', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await exec(
      `INSERT INTO "Agent" (id, workspaceId, name, role, description, runtime, status, createdAt, updatedAt)
       VALUES ('${agentId}', '${workspaceId}', 'A', 'dev', '', 'mock', 'idle', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await exec(
      `INSERT INTO "Task" (id, workspaceId, projectId, title, description, priority, status, createdAt, updatedAt)
       VALUES ('${taskId}', '${workspaceId}', '${projectId}', 'T', '', 'medium', 'todo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await expectAbort(
      `INSERT INTO "Execution" (id, taskId, agentId, status, phase, dispatchState, endedAt, createdAt, updatedAt)
       VALUES ('${nextId('ex')}', '${taskId}', '${agentId}', 'completed', 'completed', 'terminal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      /Execution_terminal_insert_guard/,
    );
    const count = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM "Execution" WHERE taskId = '${taskId}'`,
    );
    expect(Number(count[0]?.c)).toBe(0);
  });
});

describe('T2 Execution_terminal_update_guard', () => {
  it('accepts a non-business column update on a terminal row', async () => {
    const id = await createExecutionFixture({ status: 'completed', dispatchState: 'terminal', terminal: true });
    await expect(
      exec(`UPDATE "Execution" SET summary = 'archived note' WHERE id = '${id}'`),
    ).resolves.toBe(1);
  });

  it('rejects reviving a terminal execution', async () => {
    const id = await createExecutionFixture({ status: 'completed', dispatchState: 'terminal', terminal: true });
    // Whichever guard SQLite evaluates first, the rejection must come from the
    // terminal guard family rather than from application code.
    const terminalGuards =
      /Execution_terminal_update_guard|Execution_terminal_write_guard|Execution_dispatch_transition_guard/;
    await expectAbort(`UPDATE "Execution" SET status = 'running' WHERE id = '${id}'`, terminalGuards);
    await expectAbort(
      `UPDATE "Execution" SET dispatchState = 'running' WHERE id = '${id}'`,
      terminalGuards,
    );
    // Rewriting `endedAt` is only covered by T2, which pins that specific guard.
    await expectAbort(
      `UPDATE "Execution" SET endedAt = '2026-01-01T00:00:00.000Z' WHERE id = '${id}'`,
      /Execution_terminal_update_guard/,
    );
    expect((await executionRow(id)).status).toBe('completed');
  });

  it('rejects rewriting the terminal decision', async () => {
    const id = await createExecutionFixture({ status: 'completed', dispatchState: 'terminal', terminal: true });
    await expectAbort(
      `UPDATE "Execution" SET terminalDecision = 'EXECUTION_FAILED' WHERE id = '${id}'`,
      /Execution_terminal_update_guard/,
    );
    expect((await executionRow(id)).terminalDecision).toBe('COMPLETED');
  });
});

describe('T3 Execution_terminal_write_guard', () => {
  it('accepts a complete terminal write', async () => {
    const id = await createExecutionFixture();
    await expect(
      exec(
        `UPDATE "Execution" SET status = 'completed', phase = 'completed', dispatchState = 'terminal',
           endedAt = CURRENT_TIMESTAMP, terminalDecision = 'COMPLETED', terminalDecidedAt = ${NOW_MS_SQL},
           terminalDecidedBy = 'API:terminal-event' WHERE id = '${id}'`,
      ),
    ).resolves.toBe(1);
    expect((await executionRow(id)).terminalDecision).toBe('COMPLETED');
  });

  it('rejects a terminal write without a decision', async () => {
    const id = await createExecutionFixture();
    await expectAbort(
      `UPDATE "Execution" SET status = 'completed', phase = 'completed', dispatchState = 'terminal', endedAt = CURRENT_TIMESTAMP WHERE id = '${id}'`,
      /Execution_terminal_write_guard/,
    );
    expect((await executionRow(id)).status).toBe('running');
  });

  it('rejects a decision that does not match the status', async () => {
    const id = await createExecutionFixture();
    await expectAbort(
      `UPDATE "Execution" SET status = 'failed', phase = 'failed', dispatchState = 'terminal', endedAt = CURRENT_TIMESTAMP,
         terminalDecision = 'COMPLETED', terminalDecidedAt = ${NOW_MS_SQL}, terminalDecidedBy = 'API:terminal-event' WHERE id = '${id}'`,
      /Execution_terminal_write_guard/,
    );
  });

  it('rejects a terminal tuple on a running row', async () => {
    const id = await createExecutionFixture();
    await expectAbort(
      `UPDATE "Execution" SET terminalDecision = 'COMPLETED' WHERE id = '${id}'`,
      /Execution_terminal_write_guard/,
    );
  });
});

describe('T4 Execution_dispatch_transition_guard', () => {
  it('accepts created -> repository_preparing with persisted evidence', async () => {
    const id = await createExecutionFixture();
    await insertMessage(id);
    await expect(
      exec(`UPDATE "Execution" SET dispatchState = 'repository_preparing' WHERE id = '${id}'`),
    ).resolves.toBe(1);
  });

  it('rejects created -> repository_preparing without evidence', async () => {
    const id = await createExecutionFixture();
    await expectAbort(
      `UPDATE "Execution" SET dispatchState = 'repository_preparing' WHERE id = '${id}'`,
      /Execution_dispatch_transition_guard/,
    );
    expect((await executionRow(id)).dispatchState).toBe('created');
  });

  it('rejects skipping a state', async () => {
    const id = await createExecutionFixture();
    await insertMessage(id, { messageType: 'execution.start' });
    await expectAbort(
      `UPDATE "Execution" SET dispatchState = 'start_sent', startSentAt = CURRENT_TIMESTAMP,
         startAcceptDeadlineAt = datetime(CURRENT_TIMESTAMP, '+20 seconds'),
         recoveryDeadlineAt = datetime(CURRENT_TIMESTAMP, '+120 seconds') WHERE id = '${id}'`,
      /Execution_dispatch_transition_guard/,
    );
  });

  it('accepts the full six-state walk and rejects leaving terminal', async () => {
    const id = await createExecutionFixture();
    await insertMessage(id);
    await exec(`UPDATE "Execution" SET dispatchState = 'repository_preparing' WHERE id = '${id}'`);
    await exec(
      `UPDATE "Execution" SET dispatchState = 'repository_ready', repositoryPath = 'C:/repo',
         repositoryPreparedAt = CURRENT_TIMESTAMP WHERE id = '${id}'`,
    );
    await insertMessage(id, { messageType: 'execution.start' });
    await exec(
      `UPDATE "Execution" SET dispatchState = 'start_sent', startSentAt = CURRENT_TIMESTAMP,
         startAcceptDeadlineAt = datetime(CURRENT_TIMESTAMP, '+20 seconds'),
         recoveryDeadlineAt = datetime(CURRENT_TIMESTAMP, '+120 seconds') WHERE id = '${id}'`,
    );
    await exec(`UPDATE "Execution" SET dispatchState = 'running' WHERE id = '${id}'`);
    await exec(
      `UPDATE "Execution" SET status = 'completed', phase = 'completed', dispatchState = 'terminal',
         endedAt = CURRENT_TIMESTAMP, terminalDecision = 'COMPLETED', terminalDecidedAt = ${NOW_MS_SQL},
         terminalDecidedBy = 'API:terminal-event' WHERE id = '${id}'`,
    );
    expect((await executionRow(id)).dispatchState).toBe('terminal');
    await expectAbort(
      `UPDATE "Execution" SET dispatchState = 'created' WHERE id = '${id}'`,
      /Execution_dispatch_transition_guard|Execution_terminal_update_guard/,
    );
  });
});

describe('T5 Execution_start_clock_guard', () => {
  async function executionAtStartSent(): Promise<string> {
    const id = await createExecutionFixture({ dispatchState: 'created' });
    await insertMessage(id);
    await exec(`UPDATE "Execution" SET dispatchState = 'repository_preparing' WHERE id = '${id}'`);
    await exec(
      `UPDATE "Execution" SET dispatchState = 'repository_ready', repositoryPath = 'C:/repo',
         repositoryPreparedAt = CURRENT_TIMESTAMP WHERE id = '${id}'`,
    );
    await insertMessage(id, { messageType: 'execution.start' });
    await exec(
      `UPDATE "Execution" SET dispatchState = 'start_sent', startSentAt = '2026-01-01T00:00:00.000Z',
         startAcceptDeadlineAt = '2026-01-01T00:00:20.000Z',
         recoveryDeadlineAt = '2026-01-01T00:02:00.000Z' WHERE id = '${id}'`,
    );
    return id;
  }

  it('accepts the initial start clock', async () => {
    const id = await executionAtStartSent();
    expect((await executionRow(id)).startSentAt).toBeTruthy();
  });

  it('rejects rewriting startSentAt', async () => {
    const id = await executionAtStartSent();
    await expectAbort(
      `UPDATE "Execution" SET startSentAt = '2026-01-01T00:00:05.000Z' WHERE id = '${id}'`,
      /Execution_start_clock_guard/,
    );
  });

  it('rejects extending the recovery deadline', async () => {
    const id = await executionAtStartSent();
    await expectAbort(
      `UPDATE "Execution" SET recoveryDeadlineAt = '2026-01-01T00:05:00.000Z' WHERE id = '${id}'`,
      /Execution_start_clock_guard/,
    );
  });

  it('accepts tightening the recovery deadline', async () => {
    const id = await executionAtStartSent();
    await expect(
      exec(`UPDATE "Execution" SET recoveryDeadlineAt = '2026-01-01T00:01:00.000Z' WHERE id = '${id}'`),
    ).resolves.toBe(1);
  });

  it('rejects a deadline that is not ordered after startSentAt', async () => {
    const id = await executionAtStartSent();
    await expectAbort(
      `UPDATE "Execution" SET recoveryDeadlineAt = '2026-01-01T00:00:00.000Z' WHERE id = '${id}'`,
      /Execution_start_clock_guard/,
    );
  });
});

describe('T6 Runner_registration_guard', () => {
  it('accepts a rotation that advances the epoch by one', async () => {
    await expect(
      exec(
        `UPDATE "Runner" SET registrationId = 'reg-A', registrationEpoch = 1, lastRegisteredAt = CURRENT_TIMESTAMP WHERE id = 'rn_fixture'`,
      ),
    ).resolves.toBe(1);
  });

  it('rejects an epoch that jumps', async () => {
    await expectAbort(
      `UPDATE "Runner" SET registrationId = 'reg-B', registrationEpoch = 3 WHERE id = 'rn_fixture'`,
      /Runner_registration_guard/,
    );
  });

  it('rejects an epoch that rolls back', async () => {
    await expectAbort(
      `UPDATE "Runner" SET registrationEpoch = 0 WHERE id = 'rn_fixture'`,
      /Runner_registration_guard/,
    );
  });

  it('rejects rotating the id without advancing the epoch', async () => {
    await expectAbort(
      `UPDATE "Runner" SET registrationId = 'reg-C' WHERE id = 'rn_fixture'`,
      /Runner_registration_guard/,
    );
  });

  it('rejects a placeholder id', async () => {
    await expectAbort(
      `UPDATE "Runner" SET registrationId = '' WHERE id = 'rn_fixture'`,
      /Runner_registration_guard/,
    );
  });
});

describe('T7 RepositoryHandshakeMessage_insert_guard', () => {
  it('accepts a well-formed created message', async () => {
    const id = await createExecutionFixture();
    await expect(insertMessage(id)).resolves.toBeTruthy();
  });

  it('rejects a malformed payload hash', async () => {
    const id = await createExecutionFixture();
    await expect(insertMessage(id, { payloadHash: 'not-a-hash' })).rejects.toThrow(
      /RepositoryHandshakeMessage_insert_guard/,
    );
  });

  it('rejects an unknown message type', async () => {
    const id = await createExecutionFixture();
    await expect(insertMessage(id, { messageType: 'execution.terminal' })).rejects.toThrow(
      /RepositoryHandshakeMessage_insert_guard/,
    );
  });

  it('rejects a sent message without sentAt', async () => {
    const id = await createExecutionFixture();
    await expect(insertMessage(id, { status: 'sent' })).rejects.toThrow(
      /RepositoryHandshakeMessage_insert_guard/,
    );
  });

  it('enforces one execution.start per execution across attempts', async () => {
    const id = await createExecutionFixture();
    await insertMessage(id, { messageType: 'execution.start' });
    await expect(
      insertMessage(id, { messageType: 'execution.start', attempt: 2 }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe('T8 RepositoryHandshakeMessage_update_guard', () => {
  it('accepts created -> sent -> acked', async () => {
    const id = await createExecutionFixture();
    const messageId = await insertMessage(id);
    await expect(
      exec(
        `UPDATE "RepositoryHandshakeMessage" SET status = 'sent', sentAt = CURRENT_TIMESTAMP WHERE messageId = '${messageId}'`,
      ),
    ).resolves.toBe(1);
    await expect(
      exec(
        `UPDATE "RepositoryHandshakeMessage" SET status = 'acked', ackedAt = CURRENT_TIMESTAMP WHERE messageId = '${messageId}'`,
      ),
    ).resolves.toBe(1);
  });

  it('rejects mutating the persisted envelope', async () => {
    const id = await createExecutionFixture();
    const messageId = await insertMessage(id);
    await expectAbort(
      `UPDATE "RepositoryHandshakeMessage" SET envelopeJson = '{"tampered":true}' WHERE messageId = '${messageId}'`,
      /RepositoryHandshakeMessage_update_guard/,
    );
  });

  it('rejects an illegal status transition', async () => {
    const id = await createExecutionFixture();
    const messageId = await insertMessage(id, {
      status: 'acked',
      sentAt: '2026-01-01T00:00:00.000Z',
      ackedAt: '2026-01-01T00:00:01.000Z',
    });
    await expectAbort(
      `UPDATE "RepositoryHandshakeMessage" SET status = 'created' WHERE messageId = '${messageId}'`,
      /RepositoryHandshakeMessage_update_guard/,
    );
  });

  it('rejects recording a replay for execution.start', async () => {
    const id = await createExecutionFixture();
    const messageId = await insertMessage(id, {
      messageType: 'execution.start',
      status: 'sent',
      sentAt: '2026-01-01T00:00:00.000Z',
    });
    await expectAbort(
      `UPDATE "RepositoryHandshakeMessage" SET lastReplayedAt = CURRENT_TIMESTAMP WHERE messageId = '${messageId}'`,
      /RepositoryHandshakeMessage_update_guard/,
    );
  });

  it('accepts recording a replay for execution.repository', async () => {
    const id = await createExecutionFixture();
    const messageId = await insertMessage(id, { status: 'sent', sentAt: '2026-01-01T00:00:00.000Z' });
    await expect(
      exec(
        `UPDATE "RepositoryHandshakeMessage" SET lastReplayedAt = '2026-01-01T00:00:02.000Z' WHERE messageId = '${messageId}'`,
      ),
    ).resolves.toBe(1);
  });
});

describe('T9 ExecutionRegistrationAudit_insert_guard', () => {
  interface AuditOverrides {
    decision?: string;
    reasonCode?: string | null;
    newEpoch?: string;
    dispatchState?: string;
    previousId?: string | null;
    previousEpoch?: number | null;
  }

  async function insertAudit(id: string, overrides: AuditOverrides = {}): Promise<number> {
    const decision = overrides.decision ?? 'adopted';
    const reasonCode = overrides.reasonCode ?? null;
    const newEpoch = overrides.newEpoch ?? '2';
    const dispatchState = overrides.dispatchState ?? 'start_sent';
    const previousId = overrides.previousId === undefined ? 'reg-old' : overrides.previousId;
    const previousEpoch =
      overrides.previousEpoch === undefined ? 1 : overrides.previousEpoch;
    return exec(
      `INSERT INTO "ExecutionRegistrationAudit"
        (id, executionId, runnerId, previousRegistrationId, previousRegistrationEpoch, newRegistrationId, newRegistrationEpoch, dispatchState, decision, reasonCode, detail, messageId, createdAt)
       VALUES ('${nextId('au')}', '${id}', 'rn_fixture',
        ${previousId === null ? 'NULL' : `'${previousId}'`},
        ${previousEpoch === null ? 'NULL' : previousEpoch},
        'reg-new', ${newEpoch}, '${dispatchState}', '${decision}',
        ${reasonCode ? `'${reasonCode}'` : 'NULL'}, 'detail', NULL, CURRENT_TIMESTAMP)`,
    );
  }

  it('accepts an adopted takeover that advances the epoch by one', async () => {
    const id = await createExecutionFixture();
    await expect(insertAudit(id)).resolves.toBe(1);
  });

  it('accepts an adopted first binding with no previous registration', async () => {
    const id = await createExecutionFixture();
    await expect(
      insertAudit(id, { previousId: null, previousEpoch: null, newEpoch: '0' }),
    ).resolves.toBe(1);
  });

  it('rejects an adopted takeover that skips an epoch', async () => {
    const id = await createExecutionFixture();
    await expect(insertAudit(id, { newEpoch: '3' })).rejects.toThrow(
      /ExecutionRegistrationAudit_insert_guard/,
    );
  });

  it('accepts a rejection with a reason code', async () => {
    const id = await createExecutionFixture();
    await expect(
      insertAudit(id, { decision: 'rejected', reasonCode: 'EXECUTION_TERMINAL' }),
    ).resolves.toBe(1);
  });

  it('rejects a rejection without a reason code', async () => {
    const id = await createExecutionFixture();
    await expect(insertAudit(id, { decision: 'rejected' })).rejects.toThrow(
      /ExecutionRegistrationAudit_insert_guard/,
    );
  });

  it('accepts a superseded registration that replaced an older one', async () => {
    const id = await createExecutionFixture();
    await expect(insertAudit(id, { decision: 'superseded' })).resolves.toBe(1);
  });

  it('rejects a superseded registration without the registration it replaced', async () => {
    const id = await createExecutionFixture();
    await expect(
      insertAudit(id, { decision: 'superseded', previousId: null, previousEpoch: null }),
    ).rejects.toThrow(/ExecutionRegistrationAudit_insert_guard/);
  });

  it('rejects a superseded registration that is not newer', async () => {
    const id = await createExecutionFixture();
    await expect(
      insertAudit(id, { decision: 'superseded', newEpoch: '1' }),
    ).rejects.toThrow(/ExecutionRegistrationAudit_insert_guard/);
  });

  it('rejects an unknown decision', async () => {
    const id = await createExecutionFixture();
    await expect(insertAudit(id, { decision: 'maybe' })).rejects.toThrow(
      /ExecutionRegistrationAudit_insert_guard/,
    );
  });

  it('rejects an unknown dispatch state', async () => {
    const id = await createExecutionFixture();
    await expect(insertAudit(id, { dispatchState: 'starting' })).rejects.toThrow(
      /ExecutionRegistrationAudit_insert_guard/,
    );
  });

  it('rejects an epoch that rolls back', async () => {
    const id = await createExecutionFixture();
    await expect(insertAudit(id, { newEpoch: '0' })).rejects.toThrow(
      /ExecutionRegistrationAudit_insert_guard/,
    );
  });
});

describe('T10 ExecutionRegistrationAudit_no_update', () => {
  it('keeps audit rows append-only and still allows the row to be read', async () => {
    const id = await createExecutionFixture();
    await exec(
      `INSERT INTO "ExecutionRegistrationAudit"
        (id, executionId, runnerId, previousRegistrationId, previousRegistrationEpoch, newRegistrationId, newRegistrationEpoch, dispatchState, decision, reasonCode, detail, messageId, createdAt)
       VALUES ('au_fixed', '${id}', 'rn_fixture', 'reg-old', 1, 'reg-new', 2, 'start_sent', 'adopted', NULL, 'first', NULL, CURRENT_TIMESTAMP)`,
    );
    await expectAbort(
      `UPDATE "ExecutionRegistrationAudit" SET detail = 'rewritten' WHERE id = 'au_fixed'`,
      /ExecutionRegistrationAudit_no_update/,
    );
    const rows = await prisma.$queryRawUnsafe<Array<{ detail: string }>>(
      `SELECT detail FROM "ExecutionRegistrationAudit" WHERE id = 'au_fixed'`,
    );
    expect(rows[0]?.detail).toBe('first');
  });

  it('removes audit rows only through an Execution cascade', async () => {
    const id = await createExecutionFixture();
    await exec(
      `INSERT INTO "ExecutionRegistrationAudit"
        (id, executionId, runnerId, previousRegistrationId, previousRegistrationEpoch, newRegistrationId, newRegistrationEpoch, dispatchState, decision, reasonCode, detail, messageId, createdAt)
       VALUES ('au_cascade', '${id}', 'rn_fixture', 'reg-old', 1, 'reg-new', 2, 'start_sent', 'adopted', NULL, 'first', NULL, CURRENT_TIMESTAMP)`,
    );
    await exec(`DELETE FROM "Execution" WHERE id = '${id}'`);
    const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM "ExecutionRegistrationAudit" WHERE id = 'au_cascade'`,
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });
});

describe('L2 v1.1 terminal decision matrix (database-enforced)', () => {
  it('pins the frozen contract fixture to the 13 decisions and 3 statuses', () => {
    expect(L2.terminalDecisions).toHaveLength(13);
    expect(new Set(L2.terminalDecisions).size).toBe(13);
    expect(Object.keys(L2.terminalDecisionStatus).sort()).toEqual(
      [...L2.terminalDecisions].sort(),
    );
    expect(new Set(Object.values(L2.terminalDecisionStatus))).toEqual(
      new Set(['completed', 'failed', 'cancelled']),
    );
    expect(L2.terminalDecidedBy.prefixes).toEqual(['API:', 'MIGRATION:']);
    expect(L2.executionRegistrationAudit.decisions).toEqual([
      'adopted',
      'rejected',
      'superseded',
    ]);
  });

  it('accepts every frozen decision with its mapped status', async () => {
    const graph = await createGraph();
    for (const decision of L2.terminalDecisions) {
      const status = L2.terminalDecisionStatus[decision]!;
      const id = await insertExecutionRaw(graph, {
        status,
        decision: `'${decision}'`,
      });
      expect((await executionRow(id)).terminalDecision).toBe(decision);
    }
  });

  it('rejects every frozen decision with each wrong status', async () => {
    const graph = await createGraph();
    let rejected = 0;
    for (const decision of L2.terminalDecisions) {
      const mapped = L2.terminalDecisionStatus[decision]!;
      for (const status of L2.terminalStatuses) {
        if (status === mapped) {
          continue;
        }
        await expect(
          insertExecutionRaw(graph, { status, decision: `'${decision}'` }),
        ).rejects.toThrow(/Execution_terminal_insert_guard/);
        rejected += 1;
      }
    }
    // 13 decisions x 2 wrong statuses each.
    expect(rejected).toBe(26);
  });

  it('rejects an unknown decision even when the status is terminal', async () => {
    const graph = await createGraph();
    await expect(
      insertExecutionRaw(graph, { status: 'failed', decision: `'CLI_TIMEOUT'` }),
    ).rejects.toThrow(/Execution_terminal_insert_guard/);
  });

  it('rejects phase != status on a terminal insert', async () => {
    const graph = await createGraph();
    await expect(
      insertExecutionRaw(graph, { status: 'completed', phase: 'failed' }),
    ).rejects.toThrow(/Execution_terminal_insert_guard/);
  });

  it('rejects phase != status when leaving running', async () => {
    const id = await createExecutionFixture();
    await expectAbort(
      `UPDATE "Execution" SET status = 'completed', phase = 'failed', dispatchState = 'terminal',
         endedAt = CURRENT_TIMESTAMP, terminalDecision = 'COMPLETED', terminalDecidedAt = ${NOW_MS_SQL},
         terminalDecidedBy = '${LEGAL_DECIDED_BY}' WHERE id = '${id}'`,
      /Execution_terminal_write_guard/,
    );
    expect((await executionRow(id)).status).toBe('running');
  });

  it('rejects TEXT, zero, negative and fractional terminalDecidedAt values', async () => {
    const graph = await createGraph();
    const invalid = [
      `'2026-01-01T00:00:00.000Z'`,
      'CURRENT_TIMESTAMP',
      '0',
      '-1',
      '1.5',
    ];
    for (const decidedAt of invalid) {
      await expect(
        insertExecutionRaw(graph, { status: 'completed', decidedAt }),
      ).rejects.toThrow(/Execution_terminal_insert_guard/);
    }
    await expect(
      insertExecutionRaw(graph, {
        status: 'completed',
        decidedAt: '1767225600000',
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a non-integer terminalDecidedAt when leaving running', async () => {
    const id = await createExecutionFixture();
    await expectAbort(
      `UPDATE "Execution" SET status = 'completed', phase = 'completed', dispatchState = 'terminal',
         endedAt = CURRENT_TIMESTAMP, terminalDecision = 'COMPLETED',
         terminalDecidedAt = '2026-01-01T00:00:00.000Z',
         terminalDecidedBy = '${LEGAL_DECIDED_BY}' WHERE id = '${id}'`,
      /Execution_terminal_write_guard/,
    );
    expect((await executionRow(id)).status).toBe('running');
  });

  it('rejects every illegal terminalDecidedBy identity', async () => {
    const graph = await createGraph();
    const invalid = [
      `'api:operator'`,
      `'operator'`,
      `'seed:demo-data'`,
      `'legacy-backfill'`,
      `'rn_fixture'`,
      `'runner:rn_fixture'`,
      `'API:'`,
      `'MIGRATION:'`,
      `''`,
    ];
    for (const decidedBy of invalid) {
      await expect(
        insertExecutionRaw(graph, { status: 'failed', decidedBy }),
      ).rejects.toThrow(/Execution_terminal_insert_guard/);
    }
    await expect(
      insertExecutionRaw(graph, {
        status: 'failed',
        decidedBy: `'MIGRATION:wp-d-backfill'`,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('T2 terminal tuple immutability', () => {
  const immutableFields = [
    { sql: `phase = 'failed'`, pattern: /Execution_terminal_update_guard/ },
    { sql: `terminalDecision = 'EXECUTION_FAILED'`, pattern: /Execution_terminal_update_guard/ },
    { sql: `terminalDecidedAt = 1767225600000`, pattern: /Execution_terminal_update_guard/ },
    { sql: `terminalDecidedBy = 'API:operator'`, pattern: /Execution_terminal_update_guard/ },
    { sql: `status = 'failed'`, pattern: /Execution_terminal_update_guard/ },
    {
      sql: `dispatchState = 'running'`,
      pattern: /Execution_terminal_update_guard|Execution_dispatch_transition_guard/,
    },
    {
      sql: `endedAt = '2026-01-01T00:00:00.000Z'`,
      pattern: /Execution_terminal_update_guard/,
    },
    { sql: `exitCode = 1`, pattern: /Execution_terminal_update_guard/ },
  ];

  it('rejects every attempt to rewrite the terminal tuple or status', async () => {
    const id = await createExecutionFixture({
      status: 'completed',
      dispatchState: 'terminal',
      terminal: true,
    });
    const before = await executionRow(id);
    for (const field of immutableFields) {
      await expectAbort(
        `UPDATE "Execution" SET ${field.sql} WHERE id = '${id}'`,
        field.pattern,
      );
    }
    const after = await executionRow(id);
    expect(after).toEqual(before);
  });
});

describe('first terminal writer wins at the database boundary', () => {
  it('lets exactly one of two independent connections perform the transition', async () => {
    const id = await createExecutionFixture();
    const first = new DatabaseSync(database.path);
    const second = new DatabaseSync(database.path);
    try {
      first.exec('PRAGMA busy_timeout = 5000');
      second.exec('PRAGMA busy_timeout = 5000');
      const statement = `UPDATE "Execution"
           SET status = ?, phase = ?, dispatchState = 'terminal', endedAt = ?,
               terminalDecision = ?, terminalDecidedAt = ?, terminalDecidedBy = ?
           WHERE id = ? AND status = 'running' AND terminalDecision IS NULL`;
      const now = Date.now();
      const winner = first
        .prepare(statement)
        .run('completed', 'completed', now, 'COMPLETED', now, 'API:terminal-event', id);
      const loser = second
        .prepare(statement)
        .run('cancelled', 'cancelled', now + 1, 'CANCELLED_CONFIRMED', now + 1, 'API:operator', id);
      expect(Number(winner.changes)).toBe(1);
      expect(Number(loser.changes)).toBe(0);
      expect(Number(winner.changes) + Number(loser.changes)).toBe(1);

      const row = await executionRow(id);
      expect(row.status).toBe('completed');
      expect(row.terminalDecision).toBe('COMPLETED');
      expect(row.terminalDecidedBy).toBe('API:terminal-event');
    } finally {
      first.close();
      second.close();
    }
  });
});
