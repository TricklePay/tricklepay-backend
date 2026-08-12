import { Prisma, type Stream } from "@prisma/client";
import { prisma } from "../db.js";

export interface UpsertStreamInput {
  streamId: bigint;
  sender: string;
  recipient: string;
  token: string;
  totalAmount: bigint;
  withdrawn: bigint;
  startTime: bigint;
  endTime: bigint;
  cliffTime: bigint;
  cancelled: boolean;
  ledger: number;
  eventId?: string;
}

// A stream at creation: the `created` event carries every field, with
// `withdrawn` zero and `cancelled` false by definition.
export interface InsertStreamInput {
  streamId: bigint;
  sender: string;
  recipient: string;
  token: string;
  totalAmount: bigint;
  startTime: bigint;
  endTime: bigint;
  cliffTime: bigint;
  ledger: number;
  eventId: string;
}

export interface WithdrawalInput {
  streamId: bigint;
  amount: bigint;
  ledger: number;
  eventId: string;
}

export interface CancellationInput {
  streamId: bigint;
  // The vested-but-unwithdrawn balance paid to the recipient as the stream was
  // cancelled.
  recipientAmount: bigint;
  // Unix seconds at which the cancellation happened, which becomes the stream's
  // frozen end time.
  cancelledAt: bigint;
  ledger: number;
  eventId: string;
}

// What a write driven by a single event did. `missing` means the stream is not
// stored, so the delta has nothing to apply to and the caller has to fall back
// to reading full state; `duplicate` means the event had already been applied
// and was correctly ignored.
export type ApplyResult = "applied" | "duplicate" | "missing";

export interface StreamFilter {
  sender?: string;
  recipient?: string;
  token?: string;
  limit?: number;
  offset?: number;
}

function decimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

// Matches a stored stream only if the given event has not already been applied
// to it. Event ids are fixed-width and zero padded, so a string comparison puts
// them in chain order; a null id is a row from before ids were recorded, which
// no event can predate.
function notYetApplied(streamId: bigint, eventId: string): Prisma.StreamWhereInput {
  return {
    streamId,
    OR: [{ lastEventId: null }, { lastEventId: { lt: eventId } }],
  };
}

// Writes the latest known state of a stream, as read in full from the contract.
// Creation sets the created ledger; later updates leave it untouched. This is
// the reconciling write: it overwrites whatever the row held, so it needs no
// replay guard, and it is authoritative regardless of which event prompted it.
export async function upsertStream(input: UpsertStreamInput): Promise<void> {
  const totalAmount = decimal(input.totalAmount);
  const withdrawn = decimal(input.withdrawn);

  await prisma.stream.upsert({
    where: { streamId: input.streamId },
    create: {
      streamId: input.streamId,
      sender: input.sender,
      recipient: input.recipient,
      token: input.token,
      totalAmount,
      withdrawn,
      startTime: input.startTime,
      endTime: input.endTime,
      cliffTime: input.cliffTime,
      cancelled: input.cancelled,
      createdLedger: input.ledger,
      updatedLedger: input.ledger,
      lastEventId: input.eventId,
    },
    update: {
      totalAmount,
      withdrawn,
      startTime: input.startTime,
      endTime: input.endTime,
      cliffTime: input.cliffTime,
      cancelled: input.cancelled,
      updatedLedger: input.ledger,
      lastEventId: input.eventId,
    },
  });
}

// Records a stream from its `created` event alone. The insert is skipped if the
// stream is already stored: a replayed `created` carries the state the stream
// had at creation, which must not overwrite withdrawals or a cancellation that
// have since been applied to the row.
export async function insertStream(input: InsertStreamInput): Promise<ApplyResult> {
  const result = await prisma.stream.createMany({
    data: [
      {
        streamId: input.streamId,
        sender: input.sender,
        recipient: input.recipient,
        token: input.token,
        totalAmount: decimal(input.totalAmount),
        withdrawn: new Prisma.Decimal(0),
        startTime: input.startTime,
        endTime: input.endTime,
        cliffTime: input.cliffTime,
        cancelled: false,
        createdLedger: input.ledger,
        updatedLedger: input.ledger,
        lastEventId: input.eventId,
      },
    ],
    skipDuplicates: true,
  });

  return result.count > 0 ? "applied" : "duplicate";
}

// Applies a `withdrawn` event as a delta on the stored row. The event carries
// only the amount moved, so the balance is incremented in the database rather
// than recomputed, which needs no read of contract state.
export async function applyWithdrawal(input: WithdrawalInput): Promise<ApplyResult> {
  const result = await prisma.stream.updateMany({
    where: notYetApplied(input.streamId, input.eventId),
    data: {
      withdrawn: { increment: decimal(input.amount) },
      updatedLedger: input.ledger,
      lastEventId: input.eventId,
    },
  });

  if (result.count > 0) return "applied";
  return classifyMiss(input.streamId);
}

// Applies a `cancelled` event. The contract freezes a cancelled stream by
// setting its total to the amount vested at cancellation and its end time to
// that moment; cancellation also settles both sides, paying the recipient their
// vested-but-unwithdrawn balance and refunding the rest to the sender. So the
// frozen total is what has been withdrawn so far plus the recipient's payout,
// and `withdrawn` reaches it, leaving nothing further withdrawable.
export async function applyCancellation(input: CancellationInput): Promise<ApplyResult> {
  const stored = await prisma.stream.findUnique({ where: { streamId: input.streamId } });
  if (!stored) return "missing";

  const frozenTotal = stored.withdrawn.plus(decimal(input.recipientAmount));

  // The withdrawn balance read above is part of the guard, so a write that
  // raced with this one loses instead of freezing the stream at a stale total.
  const result = await prisma.stream.updateMany({
    where: { ...notYetApplied(input.streamId, input.eventId), withdrawn: stored.withdrawn },
    data: {
      totalAmount: frozenTotal,
      withdrawn: frozenTotal,
      endTime: input.cancelledAt,
      cancelled: true,
      updatedLedger: input.ledger,
      lastEventId: input.eventId,
    },
  });

  return result.count > 0 ? "applied" : "duplicate";
}

// Tells the two reasons a guarded update matched nothing apart: the stream was
// never stored, or the event had already been applied to it.
async function classifyMiss(streamId: bigint): Promise<ApplyResult> {
  const exists = await prisma.stream.findUnique({
    where: { streamId },
    select: { streamId: true },
  });
  return exists ? "duplicate" : "missing";
}

export async function getStream(streamId: bigint): Promise<Stream | null> {
  return prisma.stream.findUnique({ where: { streamId } });
}

function whereFromFilter(filter: StreamFilter): Prisma.StreamWhereInput {
  const where: Prisma.StreamWhereInput = {};
  if (filter.sender) where.sender = filter.sender;
  if (filter.recipient) where.recipient = filter.recipient;
  if (filter.token) where.token = filter.token;
  return where;
}

export async function listStreams(filter: StreamFilter): Promise<Stream[]> {
  return prisma.stream.findMany({
    where: whereFromFilter(filter),
    orderBy: { streamId: "desc" },
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
  });
}

// Total number of streams matching the filter, ignoring limit and offset, so a
// client can tell how many pages exist.
export async function countStreams(filter: StreamFilter): Promise<number> {
  return prisma.stream.count({ where: whereFromFilter(filter) });
}
