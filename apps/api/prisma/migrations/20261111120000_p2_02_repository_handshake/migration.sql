-- P2-02 WP-C: execution repository handshake.
-- Additive columns only. Existing rows are backfilled so the handshake scanner
-- never re-dispatches a pre-P2-02 execution.

ALTER TABLE "Execution" ADD COLUMN "repositoryPath" TEXT;
ALTER TABLE "Execution" ADD COLUMN "repositoryPolicyVersion" TEXT;
ALTER TABLE "Execution" ADD COLUMN "repositoryContextId" TEXT;
ALTER TABLE "Execution" ADD COLUMN "repositoryBaseCommit" TEXT;
ALTER TABLE "Execution" ADD COLUMN "repositoryPreparedAt" DATETIME;
ALTER TABLE "Execution" ADD COLUMN "dispatchState" TEXT NOT NULL DEFAULT 'created';

CREATE INDEX "Execution_dispatchState_idx" ON "Execution"("dispatchState");
CREATE INDEX "Execution_runnerId_dispatchState_idx" ON "Execution"("runnerId", "dispatchState");

-- A completed/failed/cancelled row is terminal regardless of runtime.
UPDATE "Execution" SET "dispatchState" = 'terminal'
WHERE "status" IN ('completed', 'failed', 'cancelled');

-- Preserve historical running executions (including mock runs) as already
-- started. WP-D owns recovery for these; WP-C must not handshake them.
UPDATE "Execution" SET "dispatchState" = 'running'
WHERE "status" = 'running';

-- Optional durable handshake audit trail.
CREATE TABLE "RepositoryHandshakeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "bindingVersion" INTEGER,
    "policyVersion" TEXT,
    "code" TEXT,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepositoryHandshakeEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RepositoryHandshakeEvent_executionId_createdAt_idx" ON "RepositoryHandshakeEvent"("executionId", "createdAt");
