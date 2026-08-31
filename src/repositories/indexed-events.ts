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
