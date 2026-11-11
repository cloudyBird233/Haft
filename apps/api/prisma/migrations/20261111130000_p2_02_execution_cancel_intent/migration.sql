-- P2-02 WP-C closure: durable pre-start cancel intent.
-- Additive only. Historical rows keep NULL, meaning no cancel was requested.

ALTER TABLE "Execution" ADD COLUMN "cancelRequestedAt" DATETIME;
