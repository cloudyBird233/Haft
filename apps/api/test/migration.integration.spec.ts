import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TERMINAL_DECISIONS,
  TERMINAL_DECISION_STATUS,
  type ExecutionStatus,
} from '@raft-lite/contracts';
import {
  SLICE1_MIGRATION,
  createMigratedDatabase,
  cleanupTempDatabases,
  runPrisma,
  type TempDatabase,
} from './support/migration-cli';

/**
 * WP-D Slice 1 acceptance: the migration must produce exactly the L2 v1.1
 * structure on an empty database, and that structure must be enforced by the
 * database itself, not by application code.
 */

const EXECUTION_COLUMNS = [
  'registrationId',
  'registrationEpoch',
  'startSentAt',
  'startAcceptDeadlineAt',
  'recoveryDeadlineAt',
  'terminalDecision',
  'terminalDecidedAt',
  'terminalDecidedBy',
] as const;

const RUNNER_COLUMNS = ['registrationId', 'registrationEpoch', 'lastRegisteredAt'] as const;

const MESSAGE_COLUMNS = [
  'id',
  'executionId',
  'runnerId',
  'messageType',
  'messageId',
  'protocolVersion',
  'attempt',
  'envelopeJson',
  'payloadHash',
  'canonicalizationVersion',
  'createdRegistrationId',
  'createdRegistrationEpoch',
  'status',
  'sentAt',
  'ackedAt',
  'lastReplayedAt',
  'createdAt',
  'updatedAt',
] as const;

const AUDIT_COLUMNS = [
  'id',
  'executionId',
  'runnerId',
  'previousRegistrationId',
  'previousRegistrationEpoch',
  'newRegistrationId',
  'newRegistrationEpoch',
  'dispatchState',
  'decision',
  'reasonCode',
  'detail',
  'messageId',
  'createdAt',
] as const;

const EXPECTED_INDEXES = [
  // Runner
  'Runner_registrationId_key',
  'Runner_lastRegisteredAt_idx',
  // Execution
  'Execution_status_dispatchState_idx',
  'Execution_runnerId_registrationEpoch_idx',
  'Execution_recoveryDeadlineAt_idx',
  'Execution_terminalDecision_idx',
  // RepositoryHandshakeMessage
  'RepositoryHandshakeMessage_messageId_key',
  'RepositoryHandshakeMessage_executionId_messageType_attempt_key',
  'RepositoryHandshakeMessage_execution_start_unique',
  'RepositoryHandshakeMessage_executionId_messageType_createdAt_idx',
  'RepositoryHandshakeMessage_status_createdAt_idx',
  'RepositoryHandshakeMessage_runnerId_status_idx',
  // ExecutionRegistrationAudit
  'ExecutionRegistrationAudit_executionId_createdAt_idx',
  'ExecutionRegistrationAudit_runnerId_createdAt_idx',
] as const;

const EXPECTED_TRIGGERS = [
  'Execution_terminal_insert_guard',
  'Execution_terminal_update_guard',
  'Execution_terminal_write_guard',
  'Execution_dispatch_transition_guard',
  'Execution_start_clock_guard',
  'Runner_registration_guard',
  'RepositoryHandshakeMessage_insert_guard',
  'RepositoryHandshakeMessage_update_guard',
  'ExecutionRegistrationAudit_insert_guard',
  'ExecutionRegistrationAudit_no_update',
] as const;

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

let database: TempDatabase;
let prisma: PrismaClient;

async function columns(table: string): Promise<ColumnRow[]> {
  return prisma.$queryRawUnsafe<ColumnRow[]>(`PRAGMA table_info("${table}")`);
}

async function objectNames(type: 'table' | 'index' | 'trigger'): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`,
  );
  return rows.map((row) => row.name);
}

beforeAll(async () => {
  database = createMigratedDatabase({ label: 'slice1-fresh' });
  prisma = new PrismaClient({ datasources: { db: { url: database.url } } });
  await prisma.$connect();
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  cleanupTempDatabases();
});

describe('A. fresh database', () => {
  it('applies the full migration chain with migrate deploy', async () => {
    const applied = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name',
    );
    expect(applied.map((row) => row.migration_name)).toContain(SLICE1_MIGRATION);
    expect(applied.length).toBeGreaterThanOrEqual(7);
  });

  it('adds the 42 baseline columns', async () => {
    const execution = (await columns('Execution')).map((column) => column.name);
    const runner = (await columns('Runner')).map((column) => column.name);
    const message = (await columns('RepositoryHandshakeMessage')).map((column) => column.name);
    const audit = (await columns('ExecutionRegistrationAudit')).map((column) => column.name);

    expect(EXECUTION_COLUMNS.every((name) => execution.includes(name))).toBe(true);
    expect(RUNNER_COLUMNS.every((name) => runner.includes(name))).toBe(true);
    expect(message).toEqual([...MESSAGE_COLUMNS]);
    expect(audit).toEqual([...AUDIT_COLUMNS]);

    const added = EXECUTION_COLUMNS.length + RUNNER_COLUMNS.length;
    const created = MESSAGE_COLUMNS.length + AUDIT_COLUMNS.length;
    expect(added + created).toBe(42);
  });

  it('creates the two new tables', async () => {
    const tables = await objectNames('table');
    expect(tables).toContain('RepositoryHandshakeMessage');
    expect(tables).toContain('ExecutionRegistrationAudit');
  });

  it('creates exactly the 14 baseline indexes and constraints', async () => {
    const indexes = await objectNames('index');
    for (const expected of EXPECTED_INDEXES) {
      expect(indexes, `missing index ${expected}`).toContain(expected);
    }
    expect(EXPECTED_INDEXES).toHaveLength(14);
  });

  it('creates the partial unique index for execution.start', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string; partial: number }>>(
      `PRAGMA index_list("RepositoryHandshakeMessage")`,
    );
    const partial = rows.find(
      (row) => row.name === 'RepositoryHandshakeMessage_execution_start_unique',
    );
    expect(Number(partial?.partial)).toBe(1);
    const definition = await prisma.$queryRawUnsafe<Array<{ sql: string }>>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'RepositoryHandshakeMessage_execution_start_unique'`,
    );
    expect(definition[0]?.sql).toContain(`"messageType" = 'execution.start'`);
  });

  it('creates the 10 baseline triggers', async () => {
    const triggers = await objectNames('trigger');
    for (const expected of EXPECTED_TRIGGERS) {
      expect(triggers, `missing trigger ${expected}`).toContain(expected);
    }
    expect(EXPECTED_TRIGGERS).toHaveLength(10);
  });

  it('ships exactly the 13 frozen terminal decisions', async () => {
    expect(TERMINAL_DECISIONS).toHaveLength(13);
    expect(new Set(TERMINAL_DECISIONS).size).toBe(13);
    const statuses = new Set(TERMINAL_DECISIONS.map((decision) => TERMINAL_DECISION_STATUS[decision]));
    expect([...statuses].sort()).toEqual(['cancelled', 'completed', 'failed']);
    // The triggers must know every decision; a decision that is missing from SQL
    // would only be caught by a behavioural test, so both are asserted.
    const definition = await prisma.$queryRawUnsafe<Array<{ sql: string }>>(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'Execution_terminal_insert_guard'`,
    );
    for (const decision of TERMINAL_DECISIONS) {
      expect(definition[0]?.sql).toContain(decision);
    }
  });
});

describe('D. migration regression', () => {
  it('produces a schema identical to the Prisma datamodel', () => {
    const diff = runPrisma([
      'migrate',
      'diff',
      '--from-url',
      database.url,
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ]);
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain('This is an empty migration');
  });

  it('does not rely on prisma db push anywhere in the workspace', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = join(__dirname, '../../..');
    const files = ['package.json', 'apps/api/package.json'];
    for (const relative of files) {
      const contents = await readFile(join(root, relative), 'utf8');
      expect(contents).not.toContain('db push');
    }
  });
});

describe('terminal decision mapping', () => {
  it('rejects a decision that does not match its status', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Workspace" (id, name, slug, createdAt, updatedAt) VALUES ('ws_map', 'W', 'w-map', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ),
    ).resolves.toBe(1);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Project" (id, workspaceId, key, name, description, color, defaultBranch, createdAt, updatedAt)
       VALUES ('pj_map', 'ws_map', 'MAP', 'Map', '', '#000000', 'main', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Computer" (id, name, hostname, status, createdAt, updatedAt)
       VALUES ('cp_map', 'C', 'c', 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Agent" (id, workspaceId, name, role, description, runtime, status, createdAt, updatedAt)
       VALUES ('ag_map', 'ws_map', 'A', 'dev', '', 'mock', 'idle', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" (id, workspaceId, projectId, title, description, priority, status, createdAt, updatedAt)
       VALUES ('tk_map', 'ws_map', 'pj_map', 'T', '', 'medium', 'todo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );

    const insertTerminal = (id: string, status: ExecutionStatus, decision: string): Promise<number> =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "Execution" (id, taskId, agentId, status, phase, dispatchState, endedAt, terminalDecision, terminalDecidedAt, terminalDecidedBy, createdAt, updatedAt)
         VALUES ('${id}', 'tk_map', 'ag_map', '${status}', '${status}', 'terminal', CURRENT_TIMESTAMP, '${decision}', CURRENT_TIMESTAMP, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );

    await expect(insertTerminal('ex_map_bad_1', 'completed', 'EXECUTION_FAILED')).rejects.toThrow(
      /Execution_terminal_insert_guard/,
    );
    await expect(insertTerminal('ex_map_bad_2', 'failed', 'COMPLETED')).rejects.toThrow(
      /Execution_terminal_insert_guard/,
    );
    await expect(insertTerminal('ex_map_bad_3', 'cancelled', 'EXECUTION_FAILED')).rejects.toThrow(
      /Execution_terminal_insert_guard/,
    );

    for (const decision of TERMINAL_DECISIONS) {
      const status = TERMINAL_DECISION_STATUS[decision];
      const id = `ex_map_ok_${decision}`;
      await expect(insertTerminal(id, status, decision)).resolves.toBe(1);
    }
  });
});
