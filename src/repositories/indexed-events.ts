// Repository module for indexed contract event history and audit trails.
//
// Manages database persistence and querying of historical stream events,
// providing access to event timelines, decoded parameters, and ledger metadata
// for auditing and stream history inspection.
//
// Direct database access is confined to this repository layer: all reads and
// writes to the indexed_events table in PostgreSQL must flow through these
// functions rather than calling the database client directly.

import { Prisma } from "@prisma/client";
import type { StreamEvent } from "../chain/events.js";
import { prisma, withQueryTimeout } from "../db.js";

export type IndexedEventKind = "created" | "withdrawn" | "cancelled";

export interface IndexedEventRecord {
  eventId: string;
  kind: IndexedEventKind;
  streamId: string;
  ledger: number;
  txHash: string;
  sender: string | null;
  recipient: string | null;
  token: string | null;
  totalAmount: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  recipientAmount: Prisma.Decimal | null;
  senderRefund: Prisma.Decimal | null;
  startTime: bigint | null;
  endTime: bigint | null;
  cliffTime: bigint | null;
  closedAt: bigint | null;
}

function decimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

function toIndexedEventKind(kind: string): IndexedEventKind {
  if (kind === "created" || kind === "withdrawn" || kind === "cancelled") {
    return kind;
  }
  throw new Error(`Invalid indexed event kind: ${kind}`);
}

export async function listIndexedEvents(
  streamId: bigint,
  kind?: IndexedEventKind,
): Promise<IndexedEventRecord[]> {
  const where: Prisma.IndexedEventWhereInput = {
    streamId: streamId.toString(),
  };
  if (kind !== undefined) {
    where.kind = kind;
  }
  const rows = await withQueryTimeout(
    prisma.indexedEvent.findMany({
      where,
      orderBy: { eventId: "asc" },
    }),
  );
  return rows.map((row) => ({
    eventId: row.eventId,
    kind: toIndexedEventKind(row.kind),
    streamId: row.streamId,
    ledger: row.ledger,
    txHash: row.txHash,
    sender: row.sender,
    recipient: row.recipient,
    token: row.token,
    totalAmount: row.totalAmount,
    amount: row.amount,
    recipientAmount: row.recipientAmount,
    senderRefund: row.senderRefund,
    startTime: row.startTime,
    endTime: row.endTime,
    cliffTime: row.cliffTime,
    closedAt: row.closedAt,
  }));
}

export function indexedEventFromDecoded(event: StreamEvent): IndexedEventRecord {
  return {
    eventId: event.id,
    kind: event.kind,
    streamId: event.streamId.toString(),
    ledger: event.ledger,
    txHash: event.txHash,
    sender: "sender" in event ? event.sender : null,
    recipient: "recipient" in event ? event.recipient : null,
    token: "token" in event ? event.token : null,
    totalAmount: "totalAmount" in event ? decimal(event.totalAmount) : null,
    amount: "amount" in event ? decimal(event.amount) : null,
    recipientAmount: "recipientAmount" in event ? decimal(event.recipientAmount) : null,
    senderRefund: "senderRefund" in event ? decimal(event.senderRefund) : null,
    startTime: "startTime" in event ? event.startTime : null,
    endTime: "endTime" in event ? event.endTime : null,
    cliffTime: "cliffTime" in event ? event.cliffTime : null,
    closedAt: event.closedAt,
  };
}

export async function recordIndexedEvent(
  record: IndexedEventRecord,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.indexedEvent.createMany({ data: record, skipDuplicates: true });
}
