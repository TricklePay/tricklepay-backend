import { Prisma } from "@prisma/client";
import type { StreamEvent } from "../chain/events.js";

import { prisma } from "../db.js";

export interface IndexedEventInput {
  eventId: string;
  kind: string;
  streamId: string;
  ledger: number;
  txHash: string;
  sender?: string | null;
  recipient?: string | null;
  token?: string | null;
  totalAmount?: bigint | null;
  amount?: bigint | null;
  recipientAmount?: bigint | null;
  senderRefund?: bigint | null;
  startTime?: bigint | null;
  endTime?: bigint | null;
  cliffTime?: bigint | null;
  closedAt?: bigint | null;
}

function decimalValue(value?: bigint | null): Prisma.Decimal | null {
  if (value === undefined || value === null) return null;
  return new Prisma.Decimal(value.toString());
}

export function indexedEventFromDecoded(event: StreamEvent): IndexedEventInput {
  return {
    eventId: event.id,
    kind: event.kind,
    streamId: event.streamId.toString(),
    ledger: event.ledger,
    txHash: event.txHash,
    sender: "sender" in event ? event.sender : null,
    recipient: "recipient" in event ? event.recipient : null,
    token: "token" in event ? event.token : null,
    totalAmount: "totalAmount" in event ? event.totalAmount : null,
    amount: "amount" in event ? event.amount : null,
    recipientAmount: "recipientAmount" in event ? event.recipientAmount : null,
    senderRefund: "senderRefund" in event ? event.senderRefund : null,
    startTime: "startTime" in event ? event.startTime : null,
    endTime: "endTime" in event ? event.endTime : null,
    cliffTime: "cliffTime" in event ? event.cliffTime : null,
    closedAt: event.closedAt,
  };
}

// Persists an event row using the RPC event id as the primary key. The insert is
// `skipDuplicates` so replayed pages are harmless while the event remains
// available for future investigations.
export async function recordIndexedEvent(input: IndexedEventInput, tx: Prisma.TransactionClient = prisma): Promise<void> {
  await tx.indexedEvent.createMany({
    data: [{
      eventId: input.eventId,
      kind: input.kind,
      streamId: input.streamId,
      ledger: input.ledger,
      txHash: input.txHash,
      sender: input.sender,
      recipient: input.recipient,
      token: input.token,
      totalAmount: decimalValue(input.totalAmount),
      amount: decimalValue(input.amount),
      recipientAmount: decimalValue(input.recipientAmount),
      senderRefund: decimalValue(input.senderRefund),
      startTime: input.startTime,
      endTime: input.endTime,
      cliffTime: input.cliffTime,
      closedAt: input.closedAt,
    }],
    skipDuplicates: true,
  });
}
