-- Older failures remain nullable because their transaction hash may be unavailable.
ALTER TABLE "FailedEvent" ADD COLUMN "txHash" TEXT;
