-- Phase 1: runner registry, execution recovery metadata and structured logs.

-- CreateTable
CREATE TABLE "Runner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "computerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "runnerVersion" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "architecture" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'offline',
    "capabilitiesJson" TEXT NOT NULL DEFAULT '{}',
    "maxConcurrentExecutions" INTEGER NOT NULL DEFAULT 1,
    "lastHeartbeatAt" DATETIME,
    "connectedAt" DATETIME,
    "disconnectedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Runner_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "Computer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runnerId" TEXT,
    "runtime" TEXT NOT NULL DEFAULT 'mock',
    "status" TEXT NOT NULL DEFAULT 'running',
    "phase" TEXT NOT NULL DEFAULT 'running',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressMode" TEXT NOT NULL DEFAULT 'determinate',
    "exitCode" INTEGER,
    "summary" TEXT,
    "branchName" TEXT,
    "baseCommit" TEXT,
    "headCommit" TEXT,
    "lastRunnerSeq" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "failureReason" TEXT,
    "cancelReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Execution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Execution_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Execution_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "Runner" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Execution" ("agentId", "cancelReason", "createdAt", "endedAt", "failureReason", "id", "progress", "runtime", "startedAt", "status", "taskId", "updatedAt") SELECT "agentId", "cancelReason", "createdAt", "endedAt", "failureReason", "id", "progress", "runtime", "startedAt", "status", "taskId", "updatedAt" FROM "Execution";
DROP TABLE "Execution";
ALTER TABLE "new_Execution" RENAME TO "Execution";
CREATE INDEX "Execution_taskId_idx" ON "Execution"("taskId");
CREATE INDEX "Execution_agentId_idx" ON "Execution"("agentId");
CREATE INDEX "Execution_runnerId_idx" ON "Execution"("runnerId");
CREATE INDEX "Execution_status_idx" ON "Execution"("status");
CREATE INDEX "Execution_phase_idx" ON "Execution"("phase");
CREATE TABLE "new_ExecutionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stream" TEXT NOT NULL DEFAULT 'system',
    "eventId" TEXT,
    "runnerSeq" INTEGER,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutionLog_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ExecutionLog" ("executionId", "id", "level", "message", "seq", "timestamp") SELECT "executionId", "id", "level", "message", "seq", "timestamp" FROM "ExecutionLog";
DROP TABLE "ExecutionLog";
ALTER TABLE "new_ExecutionLog" RENAME TO "ExecutionLog";
CREATE INDEX "ExecutionLog_executionId_timestamp_idx" ON "ExecutionLog"("executionId", "timestamp");
CREATE UNIQUE INDEX "ExecutionLog_executionId_seq_key" ON "ExecutionLog"("executionId", "seq");
CREATE UNIQUE INDEX "ExecutionLog_executionId_eventId_key" ON "ExecutionLog"("executionId", "eventId");
CREATE UNIQUE INDEX "ExecutionLog_executionId_runnerSeq_key" ON "ExecutionLog"("executionId", "runnerSeq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Preserve terminal phases for existing rows.
UPDATE "Execution" SET "phase" = 'completed' WHERE "status" = 'completed';
UPDATE "Execution" SET "phase" = 'failed' WHERE "status" = 'failed';
UPDATE "Execution" SET "phase" = 'cancelled' WHERE "status" = 'cancelled';

-- CreateIndex
CREATE UNIQUE INDEX "Runner_computerId_key" ON "Runner"("computerId");

-- CreateIndex
CREATE INDEX "Runner_status_idx" ON "Runner"("status");

-- CreateIndex
CREATE INDEX "Runner_lastHeartbeatAt_idx" ON "Runner"("lastHeartbeatAt");
