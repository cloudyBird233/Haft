-- Phase 1.1: durable Git metadata on Execution and a separate diff artifact.

-- AlterTable
ALTER TABLE "Execution" ADD COLUMN "changedFiles" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Execution" ADD COLUMN "diffStat" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Execution" ADD COLUMN "gitStatus" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Execution" ADD COLUMN "diffTruncated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ExecutionArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'git-diff',
    "content" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExecutionArtifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExecutionArtifact_executionId_idx" ON "ExecutionArtifact"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionArtifact_executionId_kind_key" ON "ExecutionArtifact"("executionId", "kind");
