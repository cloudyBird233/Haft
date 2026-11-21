import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyPendingMigrations,
  cleanupTempDatabases,
  copyDatabase,
  createMigratedDatabase,
  type TempDatabase,
} from './support/migration-cli';

/**
 * Acceptance B: upgrading an existing pre-Slice-1 database.
 *
 * The snapshot is not a developer's local file: it is rebuilt from the real
 * pre-Slice-1 migration chain and then populated through the legacy row shapes
 * (no registration, no start clock, no terminal tuple). That makes the test
 * reproducible on a clean machine and keeps it honest about what history could
 * actually contain.
 */

let legacy: TempDatabase;
let upgraded: TempDatabase;
let legacyPrisma: PrismaClient;
let upgradedPrisma: PrismaClient;

const TABLE_COUNTS = ['Execution', 'ExecutionLog', 'ExecutionArtifact', 'Activity', 'Runner'];

async function counts(prisma: PrismaClient): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLE_COUNTS) {
    const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM "${table}"`,
    );
    result[table] = Number(rows[0]?.c ?? 0);
  }
  return result;
}

async function seedLegacyRows(prisma: PrismaClient): Promise<void> {
  const statements = [
    `INSERT INTO "Workspace" (id, name, slug, createdAt, updatedAt) VALUES ('ws_legacy', 'Legacy', 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    `INSERT INTO "Project" (id, workspaceId, key, name, description, color, defaultBranch, createdAt, updatedAt) VALUES ('pj_legacy', 'ws_legacy', 'LEG', 'Legacy', '', '#111111', 'main', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    `INSERT INTO "Computer" (id, name, hostname, status, createdAt, updatedAt) VALUES ('cp_legacy', 'Legacy', 'legacy-host', 'online', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    `INSERT INTO "Agent" (id, workspaceId, name, role, description, runtime, status, createdAt, updatedAt) VALUES ('ag_legacy', 'ws_legacy', 'Legacy agent', 'dev', '', 'mock', 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    `INSERT INTO "Task" (id, workspaceId, projectId, title, description, priority, status, createdAt, updatedAt) VALUES ('tk_legacy', 'ws_legacy', 'pj_legacy', 'Legacy task', '', 'medium', 'done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    // Legacy Runner: no registration identity existed before Slice 1.
    `INSERT INTO "Runner" (id, computerId, tokenHash, protocolVersion, runnerVersion, platform, architecture, status, capabilitiesJson, maxConcurrentExecutions, createdAt, updatedAt) VALUES ('rn_legacy', 'cp_legacy', 'hash', 1, '0.1.0', 'win32', 'x64', 'offline', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    // A completed execution with its logs, artifact and activity.
    `INSERT INTO "Execution" (id, taskId, agentId, runtime, status, phase, progress, progressMode, dispatchState, startedAt, endedAt, createdAt, updatedAt) VALUES ('ex_legacy_completed', 'tk_legacy', 'ag_legacy', 'mock', 'completed', 'completed', 100, 'determinate', 'terminal', '2026-01-02T00:00:00.000Z', '2026-01-02T00:01:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:01:00.000Z')`,
    // A second completed row in the representation Prisma actually writes:
    // DateTime as an INTEGER number of Unix milliseconds.
    `INSERT INTO "Execution" (id, taskId, agentId, runtime, status, phase, progress, progressMode, dispatchState, startedAt, endedAt, createdAt, updatedAt) VALUES ('ex_legacy_completed_integer', 'tk_legacy', 'ag_legacy', 'mock', 'completed', 'completed', 100, 'determinate', 'terminal', 1767312000000, 1767312060000, 1767312000000, 1767312060000)`,
    `INSERT INTO "ExecutionLog" (id, executionId, seq, level, message, timestamp) VALUES ('log_legacy_1', 'ex_legacy_completed', 1, 'info', 'legacy log', '2026-01-02T00:00:30.000Z')`,
    `INSERT INTO "ExecutionArtifact" (id, executionId, kind, content, byteSize, truncated, createdAt, updatedAt) VALUES ('art_legacy_1', 'ex_legacy_completed', 'git-diff', 'diff', 4, false, '2026-01-02T00:01:00.000Z', '2026-01-02T00:01:00.000Z')`,
    `INSERT INTO "Activity" (id, workspaceId, type, summary, taskId, agentId, executionId, createdAt) VALUES ('act_legacy_1', 'ws_legacy', 'execution.completed', 'done', 'tk_legacy', 'ag_legacy', 'ex_legacy_completed', '2026-01-02T00:01:00.000Z')`,
    // A failed execution and a cancelled one: neither carried a decision.
    `INSERT INTO "Execution" (id, taskId, agentId, runtime, status, phase, dispatchState, startedAt, endedAt, failureReason, createdAt, updatedAt) VALUES ('ex_legacy_failed', 'tk_legacy', 'ag_legacy', 'mock', 'failed', 'failed', 'terminal', '2026-01-03T00:00:00.000Z', '2026-01-03T00:01:00.000Z', 'boom', '2026-01-03T00:00:00.000Z', '2026-01-03T00:01:00.000Z')`,
    `INSERT INTO "Execution" (id, taskId, agentId, runtime, status, phase, dispatchState, startedAt, endedAt, cancelReason, createdAt, updatedAt) VALUES ('ex_legacy_cancelled', 'tk_legacy', 'ag_legacy', 'mock', 'cancelled', 'cancelled', 'terminal', '2026-01-04T00:00:00.000Z', '2026-01-04T00:01:00.000Z', 'operator', '2026-01-04T00:00:00.000Z', '2026-01-04T00:01:00.000Z')`,
    // Pre-start and pre-dispatch rows that WP-C left open.
    `INSERT INTO "Execution" (id, taskId, agentId, runnerId, runtime, status, phase, dispatchState, startedAt, createdAt, updatedAt) VALUES ('ex_legacy_preparing', 'tk_legacy', 'ag_legacy', 'rn_legacy', 'codex', 'running', 'queued', 'repository_preparing', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z')`,
    `INSERT INTO "Execution" (id, taskId, agentId, runnerId, runtime, status, phase, dispatchState, startedAt, createdAt, updatedAt) VALUES ('ex_legacy_created', 'tk_legacy', 'ag_legacy', 'rn_legacy', 'codex', 'running', 'queued', 'created', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z')`,
  ];
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }
}

beforeAll(async () => {
  legacy = createMigratedDatabase({ label: 'slice1-legacy', legacyOnly: true });
  legacyPrisma = new PrismaClient({ datasources: { db: { url: legacy.url } } });
  await legacyPrisma.$connect();
  await seedLegacyRows(legacyPrisma);

  upgraded = copyDatabase(legacy, 'slice1-upgrade');
  const deploy = applyPendingMigrations(upgraded);
  if (deploy.status !== 0) {
    throw new Error(`upgrade failed: ${deploy.stdout}\n${deploy.stderr}`);
  }
  upgradedPrisma = new PrismaClient({ datasources: { db: { url: upgraded.url } } });
  await upgradedPrisma.$connect();
}, 180_000);

afterAll(async () => {
  await legacyPrisma?.$disconnect();
  await upgradedPrisma?.$disconnect();
  cleanupTempDatabases();
});

describe('B. existing database upgrade', () => {
  it('keeps every historical row', async () => {
    const before = await counts(legacyPrisma);
    const after = await counts(upgradedPrisma);
    expect(after).toEqual(before);
    expect(after.Execution).toBe(6);
    expect(after.ExecutionLog).toBe(1);
    expect(after.ExecutionArtifact).toBe(1);
    expect(after.Activity).toBe(1);
  });

  it('keeps referential integrity', async () => {
    const violations = await upgradedPrisma.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check');
    expect(violations).toEqual([]);
  });

  it('maps completed and failed to their deterministic decisions', async () => {
    const rows = await upgradedPrisma.$queryRawUnsafe<
      Array<{
        id: string;
        terminalDecision: string | null;
        terminalDecidedBy: string | null;
        terminalDecidedAt: string | null;
        endedAt: string | null;
        dispatchState: string;
      }>
    >(
      `SELECT id, terminalDecision, terminalDecidedBy, terminalDecidedAt, endedAt, dispatchState
       FROM "Execution" WHERE id IN ('ex_legacy_completed', 'ex_legacy_failed') ORDER BY id`,
    );
    const completed = rows.find((row) => row.id === 'ex_legacy_completed');
    const failed = rows.find((row) => row.id === 'ex_legacy_failed');
    expect(completed).toMatchObject({
      terminalDecision: 'COMPLETED',
      terminalDecidedBy: 'MIGRATION:wp-d-backfill',
      dispatchState: 'terminal',
    });
    expect(failed).toMatchObject({
      terminalDecision: 'EXECUTION_FAILED',
      terminalDecidedBy: 'MIGRATION:wp-d-backfill',
      dispatchState: 'terminal',
    });
    // The decision instant is the recorded end of the execution, not "now".
    const decidedAt = completed!.terminalDecidedAt;
    const endedAt = completed!.endedAt;
    expect(decidedAt).not.toBeNull();
    expect(endedAt).not.toBeNull();
    if (decidedAt === null || endedAt === null) {
      throw new Error('the upgrade did not record a decision instant for a legacy terminal row');
    }
    expect(new Date(decidedAt).toISOString()).toBe(new Date(endedAt).toISOString());
  });

  it('records the backfill instant as a positive integer Unix ms value', async () => {
    const rows = await upgradedPrisma.$queryRawUnsafe<
      Array<{ storage: string; value: number | null }>
    >(
      `SELECT typeof(terminalDecidedAt) AS storage, terminalDecidedAt AS value
       FROM "Execution" WHERE id = 'ex_legacy_completed'`,
    );
    expect(rows[0]?.storage).toBe('integer');
    expect(Number(rows[0]?.value)).toBeGreaterThan(0);
    const integerRows = await upgradedPrisma.$queryRawUnsafe<
      Array<{ storage: string; value: number | null }>
    >(
      `SELECT typeof(terminalDecidedAt) AS storage, terminalDecidedAt AS value
       FROM "Execution" WHERE id = 'ex_legacy_completed_integer'`,
    );
    expect(integerRows[0]?.storage).toBe('integer');
    expect(Number(integerRows[0]?.value)).toBe(1767312060000);
    const stale = await upgradedPrisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM "Execution" WHERE terminalDecidedBy = 'legacy-backfill'`,
    );
    expect(Number(stale[0]?.c)).toBe(0);
  });

  it('never invents CANCELLED_CONFIRMED for legacy cancellations', async () => {
    const rows = await upgradedPrisma.$queryRawUnsafe<
      Array<{
        terminalDecision: string | null;
        terminalDecidedAt: string | null;
        terminalDecidedBy: string | null;
        dispatchState: string;
        status: string;
      }>
    >(
      `SELECT terminalDecision, terminalDecidedAt, terminalDecidedBy, dispatchState, status
       FROM "Execution" WHERE id = 'ex_legacy_cancelled'`,
    );
    expect(rows[0]).toMatchObject({
      status: 'cancelled',
      dispatchState: 'terminal',
      terminalDecision: null,
      terminalDecidedAt: null,
      terminalDecidedBy: null,
    });
  });

  it('leaves open pre-start rows untouched instead of fabricating messages', async () => {
    const rows = await upgradedPrisma.$queryRawUnsafe<Array<{ id: string; dispatchState: string }>>(
      `SELECT id, dispatchState FROM "Execution" WHERE id IN ('ex_legacy_preparing', 'ex_legacy_created') ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'ex_legacy_created', dispatchState: 'created' },
      { id: 'ex_legacy_preparing', dispatchState: 'repository_preparing' },
    ]);
    const messages = await upgradedPrisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM "RepositoryHandshakeMessage"`,
    );
    expect(Number(messages[0]?.c)).toBe(0);
  });

  it('gives the legacy runner a clean registration baseline', async () => {
    const rows = await upgradedPrisma.$queryRawUnsafe<
      Array<{ registrationId: string | null; registrationEpoch: number; lastRegisteredAt: string | null }>
    >(`SELECT registrationId, registrationEpoch, lastRegisteredAt FROM "Runner"`);
    expect(rows[0]).toMatchObject({
      registrationId: null,
      registrationEpoch: 0,
      lastRegisteredAt: null,
    });
  });

  it('still enforces the terminal tuple for new writes after the upgrade', async () => {
    await expect(
      upgradedPrisma.$executeRawUnsafe(
        `UPDATE "Execution" SET status = 'running', dispatchState = 'running' WHERE id = 'ex_legacy_completed'`,
      ),
    ).rejects.toThrow(/Execution_terminal_update_guard|Execution_dispatch_transition_guard/);
  });
});
