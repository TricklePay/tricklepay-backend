// Repository module for indexed contract event history and audit trails.
//
// Manages database persistence and querying of historical stream events,
// providing access to event timelines, decoded parameters, and ledger metadata
// for auditing and stream history inspection.
//
// Direct database access is confined to this repository layer: all reads and
// writes to the indexed_events table in PostgreSQL must flow through these
// functions rather than calling the database client directly.

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

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

export async function listIndexedEvents(streamId: bigint): Promise<IndexedEventRecord[]> {
  const rows = await (prisma as any).indexedEvent.findMany({
    where: { streamId: streamId.toString() },
    orderBy: { eventId: "asc" },
  });
  return rows as IndexedEventRecord[];
}

import type { StreamEvent } from "../chain/events.js";

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
    totalAmount: "totalAmount" in event ? event.totalAmount as any : null,
    amount: "amount" in event ? event.amount as any : null,
    recipientAmount: "recipientAmount" in event ? event.recipientAmount as any : null,
    senderRefund: "senderRefund" in event ? event.senderRefund as any : null,
    startTime: "startTime" in event ? event.startTime : null,
    endTime: "endTime" in event ? event.endTime : null,
    cliffTime: "cliffTime" in event ? event.cliffTime : null,
    closedAt: event.closedAt,
  };
}

export async function recordIndexedEvent(record: IndexedEventRecord, tx?: any): Promise<void> {
  const db = tx ?? prisma;
  await (db as any).indexedEvent.createMany({ data: record, skipDuplicates: true });
}
