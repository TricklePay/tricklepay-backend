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
import { prisma, withQueryTimeout } from "../db.js";
import type { StreamEvent } from "../chain/events.js";

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

export interface IndexedEventPage {
  events: IndexedEventRecord[];
  hasMore: boolean;
}

export function encodeIndexedEventCursor(eventId: string): string {
  return Buffer.from(JSON.stringify({ eventId }), "utf8").toString("base64url");
}

export function decodeIndexedEventCursor(raw: string): string | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (
      parsed &&
      typeof parsed.eventId === "string" &&
      parsed.eventId.length > 0 &&
      encodeIndexedEventCursor(parsed.eventId) === raw
    ) {
      return parsed.eventId;
    }
  } catch {
    // Invalid cursors are reported as request validation errors by the route.
  }
  return null;
}

export async function listIndexedEvents(
  streamId: bigint,
  kind?: IndexedEventKind,
): Promise<IndexedEventRecord[]> {
  const where: { streamId: string; kind?: IndexedEventKind } = {
    streamId: streamId.toString(),
  };
  if (kind !== undefined) {
    where.kind = kind;
  }
  const rows = await withQueryTimeout(
    (prisma as any).indexedEvent.findMany({
      where,
      orderBy: { eventId: "asc" },
    }),
  );
  return rows as IndexedEventRecord[];
}

export async function listIndexedEventsPage(
  streamId: bigint,
  limit: number,
  cursorEventId?: string,
  kind?: IndexedEventKind,
): Promise<IndexedEventPage> {
  const where: {
    streamId: string;
    kind?: IndexedEventKind;
    eventId?: { gt: string };
  } = {
    streamId: streamId.toString(),
  };
  if (kind !== undefined) where.kind = kind;
  if (cursorEventId !== undefined) where.eventId = { gt: cursorEventId };

  const rows = await withQueryTimeout(
    (prisma as any).indexedEvent.findMany({
      where,
      orderBy: { eventId: "asc" },
      take: limit + 1,
    }),
  );
  const events = rows.slice(0, limit) as IndexedEventRecord[];
  return { events, hasMore: rows.length > limit };
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
