import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SLICE1_MIGRATION,
  cleanupTempDatabases,
  createEmptyDatabase,
  createFaultInjectedMigrationChain,
  createMigratedDatabase,
  repairFaultInjectedChain,
  runPrisma,
  type FaultInjectedChain,
  type MigrationFaultStage,
  type TempDatabase,
} from './support/migration-cli';

/**
 * Acceptance E: a Slice 1 migration that fails half-way must be all-or-nothing.
 *
 * Prisma Migrate does not wrap a SQLite migration file in a transaction by
 * itself, so the migration carries an explicit `BEGIN IMMEDIATE ... COMMIT`.
 * These tests inject a real SQL failure after the DDL, after the historical
 * backfill, in the middle of the trigger block and at the very end, then inspect
 * `sqlite_master`, `PRAGMA table_info`, the data rows and `_prisma_migrations`
 * directly. The same suite proves the documented recovery path: fix the file,
 * `migrate resolve --rolled-back`, deploy again.
 */

const STAGES: MigrationFaultStage[] = [
  'after-ddl',
  'after-backfill',
  'mid-triggers',
  'after-triggers',
];

const SLICE1_EXECUTION_COLUMNS = [
  'registrationId',
  'registrationEpoch',
  'startSentAt',
  'startAcceptDeadlineAt',
  'recoveryDeadlineAt',
  'terminalDecision',
  'terminalDecidedAt',
  'terminalDecidedBy',
];

const SLICE1_INDEXES = [
  'Runner_registrationId_key',
  'Runner_lastRegisteredAt_idx',
  'Execution_status_dispatchState_idx',
  'Execution_runnerId_registrationEpoch_idx',
  'Execution_recoveryDeadlineAt_idx',
  'Execution_terminalDecision_idx',
  'RepositoryHandshakeMessage_messageId_key',
  'RepositoryHandshakeMessage_executionId_messageType_attempt_key',
  'RepositoryHandshakeMessage_execution_start_unique',
  'RepositoryHandshakeMessage_executionId_messageType_createdAt_idx',
  'RepositoryHandshakeMessage_status_createdAt_idx',
  'RepositoryHandshakeMessage_runnerId_status_idx',
  'ExecutionRegistrationAudit_executionId_createdAt_idx',
  'ExecutionRegistrationAudit_runnerId_createdAt_idx',
];

function openReader(database: TempDatabase): DatabaseSync {  return new DatabaseSync(database.path);
}

function objectNames(db: DatabaseSync, type: 'table' | 'index' | 'trigger'): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
    .all(type) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function deploy(
  chain: FaultInjectedChain,
  database: TempDatabase,
): { status: number | null; output: string } {
  const result = runPrisma(['migrate', 'deploy', '--schema', chain.schemaPath], {
    DATABASE_URL: database.url,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function slice1Records(db: DatabaseSync): Array<{
  migration_name: string;
  finished_at: string | null;
  rolled_back_at: string | null;
}> {
  return db
    .prepare(
      `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = ? ORDER BY started_at`,
    )
    .all(SLICE1_MIGRATION) as Array<{
    migration_name: string;
    finished_at: string | null;
    rolled_back_at: string | null;
  }>;
}

afterAll(() => {
  cleanupTempDatabases();
});

describe.each(STAGES)('fault injection %s', (stage) => {
  it('rolls back all DDL and leaves no applied migration record', () => {
    const chain = createFaultInjectedMigrationChain(`atomic-${stage}`, stage);
    const database = createEmptyDatabase(`atomic-${stage}`);
    const result = deploy(chain, database);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/__fault_injection_probe__/);

    const db = openReader(database);
    try {
      // Nothing from Slice 1 survived: no columns, no tables, no indexes, no
      // triggers. The legacy objects created by earlier migrations are intact.
      const executionColumns = columnNames(db, 'Execution');
      for (const column of SLICE1_EXECUTION_COLUMNS) {
        expect(executionColumns, `column ${column} leaked`).not.toContain(column);
      }
      const tables = objectNames(db, 'table');
      expect(tables).not.toContain('RepositoryHandshakeMessage');
      expect(tables).not.toContain('ExecutionRegistrationAudit');
      const indexes = objectNames(db, 'index');
      for (const index of SLICE1_INDEXES) {
        expect(indexes, `index ${index} leaked`).not.toContain(index);
      }
      expect(objectNames(db, 'trigger')).toEqual([]);

      // The legacy chain (6 migrations) is still applied; Slice 1 is recorded as
      // failed, never as successful.
      const applied = db
        .prepare(`SELECT COUNT(*) AS c FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)
        .get() as { c: number | bigint };
      expect(Number(applied.c)).toBe(6);
      const records = slice1Records(db);
      expect(records).toHaveLength(1);
      expect(records[0]?.finished_at).toBeNull();
      expect(records[0]?.rolled_back_at).toBeNull();
      expect(records.filter((record) => record.finished_at !== null)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('fault injection after the historical backfill on an existing database', () => {
  it('rolls the backfill back together with the columns it wrote to', () => {
    const legacy = createMigratedDatabase({ label: 'atomic-legacy', legacyOnly: true });
    const legacyDb = openReader(legacy);
    let legacyExecutionCount = 0;
    try {
      legacyDb
        .prepare(
          `INSERT INTO "Workspace" (id, name, slug, createdAt, updatedAt) VALUES ('ws_atomic', 'W', 'w-atomic', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run();
      legacyDb
        .prepare(
          `INSERT INTO "Project" (id, workspaceId, key, name, description, color, defaultBranch, createdAt, updatedAt) VALUES ('pj_atomic', 'ws_atomic', 'ATM', 'P', '', '#000000', 'main', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run();
      legacyDb
        .prepare(
          `INSERT INTO "Agent" (id, workspaceId, name, role, description, runtime, status, createdAt, updatedAt) VALUES ('ag_atomic', 'ws_atomic', 'A', 'dev', '', 'mock', 'idle', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run();
      legacyDb
        .prepare(
          `INSERT INTO "Task" (id, workspaceId, projectId, title, description, priority, status, createdAt, updatedAt) VALUES ('tk_atomic', 'ws_atomic', 'pj_atomic', 'T', '', 'medium', 'done', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run();
      legacyDb
        .prepare(
          `INSERT INTO "Execution" (id, taskId, agentId, runtime, status, phase, dispatchState, startedAt, endedAt, createdAt, updatedAt) VALUES ('ex_atomic', 'tk_atomic', 'ag_atomic', 'mock', 'completed', 'completed', 'terminal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run();
      const count = legacyDb
        .prepare(`SELECT COUNT(*) AS c FROM "Execution"`)
        .get() as { c: number | bigint };
      legacyExecutionCount = Number(count.c);
    } finally {
      legacyDb.close();
    }

    const chain = createFaultInjectedMigrationChain('atomic-backfill-legacy', 'after-backfill');
    const result = deploy(chain, legacy);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/__fault_injection_probe__/);

    const db = openReader(legacy);
    try {
      expect(columnNames(db, 'Execution')).not.toContain('terminalDecision');
      expect(objectNames(db, 'table')).not.toContain('RepositoryHandshakeMessage');
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM "Execution"`)
        .get() as { c: number | bigint };
      expect(Number(count.c)).toBe(legacyExecutionCount);
      const record = slice1Records(db)[0];
      expect(record?.finished_at).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('recovery after a fully rolled-back failure', () => {
  it('refuses to continue, then applies cleanly after resolve --rolled-back', () => {
    const chain = createFaultInjectedMigrationChain('atomic-retry', 'after-backfill');
    const database = createEmptyDatabase('atomic-retry');

    const first = deploy(chain, database);
    expect(first.status).not.toBe(0);

    // Prisma must fail closed: the failed record blocks every later deploy until
    // an operator explicitly resolves it.
    const blocked = deploy(chain, database);
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toMatch(/P3009|failed migration/i);

    repairFaultInjectedChain(chain);
    const resolved = runPrisma(
      ['migrate', 'resolve', '--rolled-back', SLICE1_MIGRATION, '--schema', chain.schemaPath],
      { DATABASE_URL: database.url },
    );
    expect(resolved.status, `${resolved.stdout}\n${resolved.stderr}`).toBe(0);

    const retried = deploy(chain, database);
    expect(retried.status, retried.output).toBe(0);

    const db = openReader(database);
    try {
      const executionColumns = columnNames(db, 'Execution');
      for (const column of SLICE1_EXECUTION_COLUMNS) {
        expect(executionColumns).toContain(column);
      }
      expect(objectNames(db, 'table')).toContain('RepositoryHandshakeMessage');
      expect(objectNames(db, 'table')).toContain('ExecutionRegistrationAudit');
      const triggers = objectNames(db, 'trigger');
      expect(triggers).toHaveLength(10);
      const indexes = objectNames(db, 'index');
      for (const index of SLICE1_INDEXES) {
        expect(indexes).toContain(index);
      }
      const successful = slice1Records(db).filter((record) => record.finished_at !== null);
      expect(successful).toHaveLength(1);

      const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{
        integrity_check: string;
      }>;
      expect(integrity.map((row) => row.integrity_check)).toEqual(['ok']);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
