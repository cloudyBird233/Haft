-- CreateTable
CREATE TABLE "ProjectRepositoryBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "pathHash" TEXT NOT NULL,
    "bindingVersion" INTEGER NOT NULL DEFAULT 1,
    "platform" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "validationRequestId" TEXT,
    "canonicalPath" TEXT,
    "headCommit" TEXT,
    "validationErrorCode" TEXT,
    "validationError" TEXT,
    "lastValidatedAt" DATETIME,
    "validatedByRunnerId" TEXT,
    "validatedBindingVersion" INTEGER,
    "policyVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectRepositoryBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectRepositoryBinding_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "Computer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectRepositoryBinding_validatedByRunnerId_fkey" FOREIGN KEY ("validatedByRunnerId") REFERENCES "Runner" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runnerId" TEXT,
    "repositoryProjectId" TEXT,
    "repositoryBindingId" TEXT,
    "repositoryBindingVersion" INTEGER,
    "repositoryDefaultBranch" TEXT,
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
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "diffStat" TEXT NOT NULL DEFAULT '',
    "gitStatus" TEXT NOT NULL DEFAULT '',
    "diffTruncated" BOOLEAN NOT NULL DEFAULT false,
    "lastRunnerSeq" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "failureReason" TEXT,
    "cancelReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Execution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Execution_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Execution_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "Runner" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Execution_repositoryBindingId_fkey" FOREIGN KEY ("repositoryBindingId") REFERENCES "ProjectRepositoryBinding" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Execution" ("agentId", "baseCommit", "branchName", "cancelReason", "changedFiles", "createdAt", "diffStat", "diffTruncated", "endedAt", "exitCode", "failureReason", "gitStatus", "headCommit", "id", "lastRunnerSeq", "phase", "progress", "progressMode", "runnerId", "runtime", "startedAt", "status", "summary", "taskId", "updatedAt") SELECT "agentId", "baseCommit", "branchName", "cancelReason", "changedFiles", "createdAt", "diffStat", "diffTruncated", "endedAt", "exitCode", "failureReason", "gitStatus", "headCommit", "id", "lastRunnerSeq", "phase", "progress", "progressMode", "runnerId", "runtime", "startedAt", "status", "summary", "taskId", "updatedAt" FROM "Execution";
DROP TABLE "Execution";
ALTER TABLE "new_Execution" RENAME TO "Execution";
CREATE INDEX "Execution_taskId_idx" ON "Execution"("taskId");
CREATE INDEX "Execution_agentId_idx" ON "Execution"("agentId");
CREATE INDEX "Execution_runnerId_idx" ON "Execution"("runnerId");
CREATE INDEX "Execution_repositoryBindingId_idx" ON "Execution"("repositoryBindingId");
CREATE INDEX "Execution_status_idx" ON "Execution"("status");
CREATE INDEX "Execution_phase_idx" ON "Execution"("phase");
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "repoUrl" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("color", "createdAt", "description", "id", "key", "name", "updatedAt", "workspaceId") SELECT "color", "createdAt", "description", "id", "key", "name", "updatedAt", "workspaceId" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");
CREATE INDEX "Project_workspaceId_archivedAt_idx" ON "Project"("workspaceId", "archivedAt");
CREATE UNIQUE INDEX "Project_workspaceId_key_key" ON "Project"("workspaceId", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProjectRepositoryBinding_projectId_status_idx" ON "ProjectRepositoryBinding"("projectId", "status");

-- CreateIndex
CREATE INDEX "ProjectRepositoryBinding_computerId_idx" ON "ProjectRepositoryBinding"("computerId");

-- CreateIndex
CREATE INDEX "ProjectRepositoryBinding_validatedByRunnerId_idx" ON "ProjectRepositoryBinding"("validatedByRunnerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRepositoryBinding_projectId_computerId_key" ON "ProjectRepositoryBinding"("projectId", "computerId");
