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
}

export interface StreamFilter {
  sender?: string;
  recipient?: string;
  limit?: number;
  offset?: number;
}

// Writes the latest known state of a stream. Creation sets the created ledger;
// later updates leave it untouched. Re-applying the same state is harmless,
// which keeps event replay idempotent.
export async function upsertStream(input: UpsertStreamInput): Promise<void> {
  const totalAmount = new Prisma.Decimal(input.totalAmount.toString());
  const withdrawn = new Prisma.Decimal(input.withdrawn.toString());

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
    },
    update: {
      totalAmount,
      withdrawn,
      startTime: input.startTime,
      endTime: input.endTime,
      cliffTime: input.cliffTime,
      cancelled: input.cancelled,
      updatedLedger: input.ledger,
    },
  });
}

export async function getStream(streamId: bigint): Promise<Stream | null> {
  return prisma.stream.findUnique({ where: { streamId } });
}

function whereFromFilter(filter: StreamFilter): Prisma.StreamWhereInput {
  const where: Prisma.StreamWhereInput = {};
  if (filter.sender) where.sender = filter.sender;
  if (filter.recipient) where.recipient = filter.recipient;
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
