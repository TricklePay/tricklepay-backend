-- CreateTable
CREATE TABLE "Stream" (
    "streamId" BIGINT NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "totalAmount" DECIMAL(40,0) NOT NULL,
    "withdrawn" DECIMAL(40,0) NOT NULL DEFAULT 0,
    "startTime" BIGINT NOT NULL,
    "endTime" BIGINT NOT NULL,
    "cliffTime" BIGINT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdLedger" INTEGER NOT NULL,
    "updatedLedger" INTEGER NOT NULL,
    "lastEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stream_pkey" PRIMARY KEY ("streamId")
);

-- CreateTable
CREATE TABLE "FailedEvent" (
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "streamId" TEXT,
    "ledger" INTEGER NOT NULL,
    "error" TEXT NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 1,
    "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FailedEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" TEXT NOT NULL,
    "lastLedger" INTEGER NOT NULL DEFAULT 0,
    "chainLedger" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Stream_sender_streamId_idx" ON "Stream"("sender", "streamId" DESC);

-- CreateIndex
CREATE INDEX "Stream_recipient_streamId_idx" ON "Stream"("recipient", "streamId" DESC);

-- CreateIndex
CREATE INDEX "Stream_token_streamId_idx" ON "Stream"("token", "streamId" DESC);

-- CreateIndex
CREATE INDEX "FailedEvent_ledger_idx" ON "FailedEvent"("ledger");
