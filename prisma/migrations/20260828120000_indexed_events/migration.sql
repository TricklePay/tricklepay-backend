CREATE TABLE "IndexedEvent" (
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "sender" TEXT,
    "recipient" TEXT,
    "token" TEXT,
    "totalAmount" DECIMAL(40,0),
    "amount" DECIMAL(40,0),
    "recipientAmount" DECIMAL(40,0),
    "senderRefund" DECIMAL(40,0),
    "startTime" BIGINT,
    "endTime" BIGINT,
    "cliffTime" BIGINT,
    "closedAt" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexedEvent_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "IndexedEvent_streamId_ledger_idx"
    ON "IndexedEvent"("streamId", "ledger");

CREATE INDEX "IndexedEvent_ledger_idx"
    ON "IndexedEvent"("ledger");
