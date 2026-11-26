// Repository module for stream records and payment stream state.
//
// Manages database persistence, lifecycle transitions (creation, withdrawals,
// and cancellations), state reconciliation, and querying (lookups, filtered
// listings, aggregations, and cursor pagination) for stream entities.
//
// Direct database access is confined to this repository layer: all queries and
// mutations against the streams table in PostgreSQL must flow through these
// functions rather than calling the database client directly.

import { Prisma, type Stream } from "@prisma/client";

import { prisma, withQueryTimeout, measureRepositoryCall } from "../db.js";
import { parseStreamId } from "../lib/stream-id.js";
import { indexedStreams } from "../metrics.js";

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
  // The vested-but-unwithdrawn balance still claimable by the recipient after cancellation.
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

export type SortKey = "streamId" | "endTime" | "totalAmount" | "createdLedger";
export type SortDirection = "asc" | "desc";

export interface StreamFilter {
  ids?: bigint[];
  sender?: string;
  recipient?: string;
  token?: string;
  cancelled?: boolean;
  status?: "pending" | "streaming" | "completed" | "cancelled";
  cursor?: string;
  limit?: number;
  offset?: number;
  minAmount?: bigint;
  maxAmount?: bigint;
  sortKey?: SortKey;
  sortDirection?: SortDirection;
}

export interface StreamListResult {
  streams: Stream[];
  nextCursor?: string;
}

interface CursorData {
  streamId: bigint;
  sortKey?: SortKey;
  sortDirection?: SortDirection;
  sortValue?: string;
}

export function encodeCursor(
  streamId: bigint,
  sortKey?: SortKey,
  sortDirection?: SortDirection,
  sortValue?: bigint | number,
): string {
  // The stream id is a bigint, which JSON.stringify cannot serialize, so it is
  // written as a decimal string and parsed back in decodeCursor.
  const data = {
    streamId: streamId.toString(),
    ...(sortKey && { sortKey }),
    ...(sortDirection && { sortDirection }),
    ...(sortValue !== undefined && { sortValue: sortValue.toString() }),
  };
  const payload = JSON.stringify(data);
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): CursorData | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.streamId === "string") {
      // The stream id must fit the database's signed BIGINT range (#796).
      const streamId = parseStreamId(parsed.streamId);
      if (streamId === null) return null;

      const result: CursorData = { streamId };

      if (parsed.sortKey) {
        if (!["streamId", "endTime", "totalAmount", "createdLedger"].includes(parsed.sortKey)) {
          return null;
        }
        result.sortKey = parsed.sortKey;
      }

      if (parsed.sortDirection) {
        if (!["asc", "desc"].includes(parsed.sortDirection)) {
          return null;
        }
        result.sortDirection = parsed.sortDirection;
      }

      if (parsed.sortValue !== undefined) {
        // A sort value is re-parsed with BigInt() when the cursor is applied,
        // so anything that is not a plain integer string is rejected here as
        // an invalid cursor rather than failing later.
        if (typeof parsed.sortValue !== "string" || !/^-?\d+$/.test(parsed.sortValue)) {
          return null;
        }
        result.sortValue = parsed.sortValue;
      }

      return result;
    }
  } catch {
    // fall through to null
  }
  return null;
}

// Repository helpers use a single input object for reads and writes. Single-row
// lookups return `null` when nothing matches, collection queries return arrays
// or counts, and a transaction client remains the optional final argument only
// for DB writes that need to participate in a larger transaction.
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
export async function upsertStream(input: UpsertStreamInput, tx: Prisma.TransactionClient = prisma): Promise<void> {
  return measureRepositoryCall("upsertStream", async () => {
    const totalAmount = decimal(input.totalAmount);
    const withdrawn = decimal(input.withdrawn);

  await tx.stream.upsert({
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
  });
}

// Records a stream from its `created` event alone. The insert is skipped if the
// stream is already stored: a replayed `created` carries the state the stream
// had at creation, which must not overwrite withdrawals or a cancellation that
// have since been applied to the row.
export async function insertStream(input: InsertStreamInput, tx: Prisma.TransactionClient = prisma): Promise<ApplyResult> {
  return measureRepositoryCall("insertStream", async () => {
  const result = await tx.stream.createMany({
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

  if (result.count > 0) {
    indexedStreams.inc();
    return "applied";
  }
  return "duplicate";
  });
}

// Applies a `withdrawn` event as a delta on the stored row. The event carries
// only the amount moved, so the balance is incremented in the database rather
// than recomputed, which needs no read of contract state.
export async function applyWithdrawal(input: WithdrawalInput, tx: Prisma.TransactionClient = prisma): Promise<ApplyResult> {
  return measureRepositoryCall("applyWithdrawal", async () => {
  const result = await tx.stream.updateMany({
    where: notYetApplied(input.streamId, input.eventId),
    data: {
      withdrawn: { increment: decimal(input.amount) },
      updatedLedger: input.ledger,
      lastEventId: input.eventId,
    },
  });

  if (result.count > 0) return "applied";
  return classifyMiss(input.streamId, tx);
  });
}

// Applies a `cancelled` event. The contract refunds the sender and freezes the
// stream's vested total at the amount already withdrawn plus the recipient's
// balance still claimable after cancellation. Withdrawn stays unchanged until
// the recipient actually claims that balance.
//
// The read and guarded update run in a single transaction so a concurrent
// withdrawal cannot change `withdrawn` between the two operations, which would
// freeze the stream at a stale total.
export async function applyCancellation(input: CancellationInput, tx: Prisma.TransactionClient = prisma): Promise<ApplyResult> {
  return measureRepositoryCall("applyCancellation", async () => {
  const applyFn = async (t: Prisma.TransactionClient) => {
    const stored = await t.stream.findUnique({ where: { streamId: input.streamId } });
    if (!stored) return "missing";

    const frozenTotal = stored.withdrawn.plus(decimal(input.recipientAmount));

    const result = await t.stream.updateMany({
      where: { ...notYetApplied(input.streamId, input.eventId), withdrawn: stored.withdrawn },
      data: {
        totalAmount: frozenTotal,
        endTime: input.cancelledAt,
        cancelled: true,
        updatedLedger: input.ledger,
        lastEventId: input.eventId,
      },
    });

    return result.count > 0 ? "applied" : "duplicate";
  };

  // If already in a tx, just run it. Otherwise start one to guard the read-modify-write.
  if (tx !== prisma) {
    return applyFn(tx);
  }
  return prisma.$transaction(applyFn);
  });
}

// Tells the two reasons a guarded update matched nothing apart: the stream was
// never stored, or the event had already been applied to it.
async function classifyMiss(streamId: bigint, tx: Prisma.TransactionClient = prisma): Promise<ApplyResult> {
  const exists = await tx.stream.findUnique({
    where: { streamId },
    select: { streamId: true },
  });
  return exists ? "duplicate" : "missing";
}

export async function getStream({ streamId }: { streamId: bigint }): Promise<Stream | null> {
  return measureRepositoryCall("getStream", () =>
    withQueryTimeout(prisma.stream.findUnique({ where: { streamId } }))
  );
}

// Repository naming convention: use `get` for one record, `list` for
// collections, `count` for totals, and action verbs for mutations.

// The database-side predicate for each lifecycle status, mirroring the summary
// endpoint logic. Used for both filtering and aggregation.
function statusWhereFilter(status: "pending" | "streaming" | "completed" | "cancelled", now: bigint): Prisma.StreamWhereInput {
  switch (status) {
    case "cancelled":
      return { cancelled: true };
    case "pending":
      return { cancelled: false, startTime: { gt: now } };
    case "completed":
      return { cancelled: false, endTime: { lte: now } };
    case "streaming":
      return { cancelled: false, startTime: { lte: now }, endTime: { gt: now } };
  }
}

function whereFromFilter(filter: StreamFilter, now?: bigint): Prisma.StreamWhereInput {
  const where: Prisma.StreamWhereInput = {};
  if (filter.sender) where.sender = filter.sender;
  if (filter.recipient) where.recipient = filter.recipient;
  if (filter.token) where.token = filter.token;
  if (filter.cancelled !== undefined) where.cancelled = filter.cancelled;

  // Handle cursor-based pagination with sort awareness
  if (filter.cursor) {
    const cursorData = decodeCursor(filter.cursor);
    if (cursorData) {
      const sortKey = filter.sortKey ?? cursorData.sortKey ?? "streamId";
      const sortDirection = filter.sortDirection ?? cursorData.sortDirection ?? "desc";

      // Build the cursor condition based on the sort key
      if (sortKey === "streamId") {
        where.streamId = sortDirection === "desc" ? { lt: cursorData.streamId } : { gt: cursorData.streamId };
      } else if (cursorData.sortValue !== undefined) {
        // For compound sort (sortKey + streamId tiebreaker), use OR condition
        const sortValueBigInt = sortKey === "totalAmount"
          ? BigInt(cursorData.sortValue)
          : sortKey === "createdLedger"
            ? Number(cursorData.sortValue)
            : BigInt(cursorData.sortValue);

        const sortField = sortKey === "totalAmount"
          ? "totalAmount"
          : sortKey === "createdLedger"
            ? "createdLedger"
            : "endTime";

        const sortValueDecimal = sortKey === "totalAmount" || sortKey === "endTime"
          ? decimal(sortValueBigInt as bigint)
          : sortValueBigInt;

        if (sortDirection === "desc") {
          where.OR = [
            { [sortField]: { lt: sortValueDecimal } },
            {
              [sortField]: sortValueDecimal,
              streamId: { lt: cursorData.streamId },
            },
          ];
        } else {
          where.OR = [
            { [sortField]: { gt: sortValueDecimal } },
            {
              [sortField]: sortValueDecimal,
              streamId: { gt: cursorData.streamId },
            },
          ];
        }
      }
    }
  } else if (filter.ids !== undefined) {
    // PostgreSQL BIGINT cannot store the upper half of uint64. Those valid
    // contract ids cannot match a row, so omit them before binding parameters.
    where.streamId = { in: filter.ids.filter((id) => id <= 9223372036854775807n) };
  }

  if (filter.minAmount !== undefined || filter.maxAmount !== undefined) {
    where.totalAmount = {
      ...(filter.minAmount === undefined ? {} : { gte: decimal(filter.minAmount) }),
      ...(filter.maxAmount === undefined ? {} : { lte: decimal(filter.maxAmount) }),
    };
  }

  // Apply status filter using the same predicates as the summary endpoint
  if (filter.status && now !== undefined) {
    const statusFilter = statusWhereFilter(filter.status, now);
    Object.assign(where, statusFilter);
  }

  return where;
}

export function orderByFromFilter(
  filter: StreamFilter,
): Prisma.StreamOrderByWithRelationInput[] {
  const orderBy: Prisma.StreamOrderByWithRelationInput[] = [];

  // Address-based ordering (legacy behavior)
  if (filter.sender) orderBy.push({ sender: "asc" });
  else if (filter.recipient) orderBy.push({ recipient: "asc" });
  else if (filter.token) orderBy.push({ token: "asc" });

  // Apply custom sort if specified
  if (filter.sortKey && filter.sortKey !== "streamId") {
    const direction = filter.sortDirection ?? "desc";
    orderBy.push({ [filter.sortKey]: direction });
  }

  // streamId is always the final tiebreaker
  const streamIdDirection = filter.sortKey && filter.sortKey !== "streamId"
    ? filter.sortDirection ?? "desc"
    : filter.sortDirection ?? "desc";
  orderBy.push({ streamId: streamIdDirection });

  return orderBy;
}

export type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

// The database-side predicate for each lifecycle status, mirroring `statusOf`
// in src/lib/stream-view.ts: cancelled wins first, then the start/end time
// windows against the clock.
export function statusWhere(status: StreamStatus, now: bigint): Prisma.StreamWhereInput {
  switch (status) {
    case "cancelled":
      return { cancelled: true };
    case "pending":
      return { cancelled: false, startTime: { gt: now } };
    case "completed":
      return { cancelled: false, endTime: { lte: now } };
    case "streaming":
      return { cancelled: false, startTime: { lte: now }, endTime: { gt: now } };
  }
}

export async function listStreams(filter: StreamFilter, now?: bigint): Promise<StreamListResult> {
  return measureRepositoryCall("listStreams", async () => {
  const limit = filter.limit ?? 50;
  const useCursor = filter.cursor !== undefined;
  const take = limit + 1;
  const skip = useCursor ? 0 : filter.offset ?? 0;

  const rows = await withQueryTimeout(
    prisma.stream.findMany({
      where: whereFromFilter(filter, now),
      orderBy: orderByFromFilter(filter),
      take,
      skip,
    }),
  );

  if (rows.length <= limit) {
    return { streams: rows };
  }

  const streams = rows.slice(0, limit);
  const last = streams[streams.length - 1];

  // Encode cursor with sort information
  const sortKey = filter.sortKey ?? "streamId";
  const sortDirection = filter.sortDirection ?? "desc";
  const sortValue = sortKey === "endTime"
    ? last.endTime
    : sortKey === "totalAmount"
      ? BigInt(last.totalAmount.toString())
      : sortKey === "createdLedger"
        ? last.createdLedger
        : undefined;

  return {
    streams,
    nextCursor: encodeCursor(last.streamId, sortKey, sortDirection, sortValue),
  };
  });
}

// Total number of streams matching the filter, ignoring limit and offset, so a
// client can tell how many pages exist.
export async function countStreams(filter: StreamFilter, now?: bigint): Promise<number> {
  return measureRepositoryCall("countStreams", () =>
    withQueryTimeout(prisma.stream.count({ where: whereFromFilter(filter, now) }))
  );
}

export interface StreamAggregate {
  count: number;
  totalAmount: Prisma.Decimal;
  withdrawn: Prisma.Decimal;
}

// Row count plus amount totals for one where clause. The sums run in Postgres
// over the decimal columns, so totals stay exact no matter how wide the
// amounts get; they come back as Decimal rather than a JavaScript number.
export async function aggregateStreams(where: Prisma.StreamWhereInput): Promise<StreamAggregate> {
  return measureRepositoryCall("aggregateStreams", async () => {
  const result = await withQueryTimeout(
    prisma.stream.aggregate({
      where,
      _count: { streamId: true },
      _sum: { totalAmount: true, withdrawn: true },
    }),
  );

  return {
    count: result._count.streamId,
    totalAmount: result._sum.totalAmount ?? new Prisma.Decimal(0),
    withdrawn: result._sum.withdrawn ?? new Prisma.Decimal(0),
  };
  });
}

export interface TokenSummary {
  token: string;
  count: number;
  totalStreamed: string;
  totalAmount: string;
  total: string;
}

// Groups streams by token and returns the distinct tokens with stream count
// and total streamed amount, including completed and cancelled streams. The
// sums run in Postgres over decimal columns so amounts stay exact.
export async function listTokens(): Promise<TokenSummary[]> {
  return measureRepositoryCall("listTokens", async () => {
  const groups = await withQueryTimeout(
    prisma.stream.groupBy({
      by: ["token"],
      _count: { streamId: true },
      _sum: { totalAmount: true },
      orderBy: { token: "asc" },
    }),
  );

  return groups.map((group) => {
    const totalAmount = group._sum.totalAmount?.toString() ?? "0";
    return {
      token: group.token,
      count: group._count.streamId,
      totalStreamed: totalAmount,
      totalAmount,
      total: totalAmount,
    };
  });
  });
}

// Returns incoming (recipient = address) and outgoing (sender = address) streams
// for a single Stellar account or contract address.
export async function getAccountStreams(
  address: string,
): Promise<{ incoming: Stream[]; outgoing: Stream[] }> {
  return measureRepositoryCall("getAccountStreams", async () => {
  const [incoming, outgoing] = await Promise.all([
    withQueryTimeout(prisma.stream.findMany({ where: { recipient: address } })),
    withQueryTimeout(prisma.stream.findMany({ where: { sender: address } })),
  ]);
  return { incoming, outgoing };
  });
}

export interface AccountTokenTotals {
  totalAmount: string;
  total: string;
  withdrawn: string;
  vested: string;
  withdrawable: string;
}

export interface AccountDirectionSummary {
  count: number;
  byToken: Record<string, AccountTokenTotals>;
}

export async function getAccountSummary(
  address: string,
  now: bigint,
): Promise<{ incoming: AccountDirectionSummary; outgoing: AccountDirectionSummary }> {
  return measureRepositoryCall("getAccountSummary", async () => {
    const rows = await withQueryTimeout(prisma.$queryRaw<Array<{
      direction: "incoming" | "outgoing";
      token: string;
      count: bigint;
      totalAmount: Prisma.Decimal;
      withdrawn: Prisma.Decimal;
      vested: Prisma.Decimal;
      withdrawable: Prisma.Decimal;
    }>>`
      WITH matched AS (
        SELECT 'incoming'::text AS direction, "token", "totalAmount", "withdrawn", "startTime", "endTime", "cliffTime"
        FROM "Stream" WHERE "recipient" = ${address}
        UNION ALL
        SELECT 'outgoing'::text AS direction, "token", "totalAmount", "withdrawn", "startTime", "endTime", "cliffTime"
        FROM "Stream" WHERE "sender" = ${address}
      ), evaluated AS (
        SELECT direction, "token", "totalAmount", "withdrawn",
          CASE
            WHEN ${now} < "cliffTime" OR ${now} < "startTime" THEN 0::numeric
            WHEN ${now} >= "endTime" THEN "totalAmount"
            ELSE trunc("totalAmount" * (${now} - "startTime")::numeric / ("endTime" - "startTime")::numeric)
          END AS vested
        FROM matched
      )
      SELECT direction, "token", COUNT(*) AS count,
        SUM("totalAmount") AS "totalAmount",
        SUM("withdrawn") AS withdrawn,
        SUM(vested) AS vested,
        SUM(GREATEST(vested - "withdrawn", 0)) AS withdrawable
      FROM evaluated GROUP BY direction, "token"
    `);

    const empty = (): AccountDirectionSummary => ({ count: 0, byToken: {} });
    const summary = { incoming: empty(), outgoing: empty() };
    for (const row of rows) {
      const totalAmount = row.totalAmount.toString();
      summary[row.direction].count += Number(row.count);
      summary[row.direction].byToken[row.token] = {
        totalAmount,
        total: totalAmount,
        withdrawn: row.withdrawn.toString(),
        vested: row.vested.toString(),
        withdrawable: row.withdrawable.toString(),
      };
    }
    return summary;
  });
}

