import { prisma } from "../db.js";
import type { Prisma } from "@prisma/client";
import type { StreamEvent } from "../chain/events.js";

export interface FailedEventInput {
  // The RPC event id — unique per event on chain and used as the primary key.
  eventId: string;
  // The decoded event kind, or "unknown" when the event could not be decoded.
  kind: string;
  // The stream id as a string (bigint cannot be stored directly in JSON/text).
  streamId: string | null;
  ledger: number;
  // The error message from the most recent failure.
  error: string;
}

// Records (or updates) a failed event. The row is upserted so that repeated
// failures increment `failureCount` and refresh `error` rather than inserting
// duplicate rows. `firstFailedAt` is only written on the initial insert.
export async function recordFailedEvent(input: FailedEventInput): Promise<void> {
  await prisma.failedEvent.upsert({
    where: { eventId: input.eventId },
    create: {
      eventId: input.eventId,
      kind: input.kind,
      streamId: input.streamId,
      ledger: input.ledger,
      error: input.error,
      failureCount: 1,
    },
    update: {
      error: input.error,
      failureCount: { increment: 1 },
    },
  });
}

// Returns the total count of unresolved failed events.
export async function countFailedEvents(): Promise<number> {
  return prisma.failedEvent.count();
}

// Removes the failed-event row for an event that subsequently applied cleanly.
// Called after a successful apply so operators can see only truly stuck events.
export async function clearFailedEvent(eventId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
  await tx.failedEvent.deleteMany({ where: { eventId } });
}

// Returns failed events ordered by ledger ascending, so the oldest stuck
// events surface first. Used by the status route to expose them to operators.
export async function listFailedEvents(limit = 100) {
  return prisma.failedEvent.findMany({
    orderBy: { ledger: "asc" },
    take: limit,
  });
}

// Builds a FailedEventInput from a decoded event and an error.
export function failedEventFromDecoded(
  event: StreamEvent,
  error: unknown,
): FailedEventInput {
  return {
    eventId: event.id,
    kind: event.kind,
    streamId: event.streamId.toString(),
    ledger: event.ledger,
    error: error instanceof Error ? error.message : String(error),
  };
}
