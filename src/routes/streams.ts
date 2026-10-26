// Registers the GET /streams, GET /streams/summary, GET /tokens, GET /streams/:id/events, and GET /streams/:id endpoints.
// These routes read stream records, historical events, and aggregations from the database.

import { createHash } from "node:crypto";

import { Prisma, type Stream } from "@prisma/client";

import { StrKey } from "@stellar/stellar-sdk";

import type { FastifyInstance } from "fastify";

import { sendError, bigIntToStringNullable } from "../lib/response.js";
import { parsePagination } from "../lib/pagination.js";
import { mapStreamResponse } from "../lib/stream-view.js";
import { MAX_UINT64, parseStreamId } from "../lib/stream-id.js";

import {
  aggregateStreams,
  countStreams,
  decodeCursor,
  getAccountStreams,
  getStream,
  listStreams,
  listTokens,
  statusWhere,
} from "../repositories/streams.js";

import {
  ACCOUNT_STREAM_SUMMARY_SCHEMA_ID,
  ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID,
  accountStreamSummarySchema,
  accountSummaryResponseSchema,
  apiErrorSchema,
  ERROR_SCHEMA_ID,
  streamEventHistoryResponseSchema,
  streamEventSchema,
  STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID,
  STREAM_EVENT_SCHEMA_ID,
  streamListResponseSchema,
  STREAM_LIST_RESPONSE_SCHEMA_ID,
  streamScheduleResponseSchema,
  STREAM_SCHEDULE_RESPONSE_SCHEMA_ID,
  streamSummaryResponseSchema,
  STREAM_SUMMARY_RESPONSE_SCHEMA_ID,
  streamViewSchema,
  STREAM_VIEW_SCHEMA_ID,
  TOKEN_LIST_RESPONSE_SCHEMA_ID,
  TOKEN_SUMMARY_SCHEMA_ID,
  tokenListResponseSchema,
  tokenSummarySchema,
} from "../schema.js";
import { listIndexedEvents, type IndexedEventKind } from "../repositories/indexed-events.js";
import { normalizeAddress } from "../lib/address.js";
import { nowSeconds } from "../lib/time.js";
import { vestedAmount, withdrawableAmount } from "../lib/vesting.js";
import { DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS } from "../config.js";

// Above this offset a scan gets expensive enough that callers should page
// through results in order or narrow them with filters instead.
const MAX_OFFSET = 10000;

// Weak ETag for list responses, derived from the serialized body so it changes
// whenever any returned field changes (streams, total, nextCursor, pagination).
// "Weak" (W/) is correct here: the body is byte-identical between revalidations
// for the same data, but we only guarantee semantic equivalence, matching the
// detail route's revalidation model without a per-row version column.
function weakEtagFromBody(body: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return `W/"${digest}"`;
}

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

function parseIncludeTotal(raw: string | undefined): boolean {
  return raw === "true";
}

function parseAtTimestamp(raw: string | undefined): bigint | null {
  if (raw === undefined) return null;

  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return null;

  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > MAX_UINT64) return null;
    return parsed;
  } catch {
    return null;
  }
}

const DEFAULT_SCHEDULE_POINTS = 50;
const MIN_SCHEDULE_POINTS = 2;
const MAX_SCHEDULE_POINTS = 100;

function computeSchedulePoints(stream: Stream, targetPoints = DEFAULT_SCHEDULE_POINTS) {
  const count = Math.max(MIN_SCHEDULE_POINTS, Math.min(targetPoints, MAX_SCHEDULE_POINTS));
  const startTime = stream.startTime;
  const endTime = stream.endTime;
  const cliffTime = stream.cliffTime;
  const total = BigInt(stream.totalAmount.toString());

  if (endTime <= startTime) {
    const v = vestedAmount(total, startTime, endTime, cliffTime, startTime);
    return [
      {
        time: startTime.toString(),
        amount: v.toString(),
        vested: v.toString(),
      },
    ];
  }

  const duration = endTime - startTime;
  const hasCliff = cliffTime > startTime && cliffTime < endTime;

  const candidateTimes = new Set<bigint>();
  for (let i = 0; i < count; i++) {
    const t = startTime + (duration * BigInt(i)) / BigInt(count - 1);
    candidateTimes.add(t);
  }

  if (hasCliff && !candidateTimes.has(cliffTime)) {
    let closest: bigint | null = null;
    let minDiff: bigint | null = null;
    for (const t of candidateTimes) {
      if (t === startTime || t === endTime) continue;
      const diff = t > cliffTime ? t - cliffTime : cliffTime - t;
      if (minDiff === null || diff < minDiff) {
        minDiff = diff;
        closest = t;
      }
    }
    if (closest !== null) {
      candidateTimes.delete(closest);
    }
    candidateTimes.add(cliffTime);
  }

  const sortedTimes = Array.from(candidateTimes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return sortedTimes.map((t) => {
    const v = vestedAmount(total, startTime, endTime, cliffTime, t);
    return {
      time: t.toString(),
      amount: v.toString(),
      vested: v.toString(),
    };
  });
}

function parseCancelled(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

const SUMMARY_STATUSES = ["pending", "streaming", "completed", "cancelled"] as const;

type SummaryEntry = { count: number; totalAmount: string; withdrawn: string };
type SummaryPayload = Record<StreamStatus, SummaryEntry>;

function summarizeAccountStreams(streams: Stream[], now: bigint) {
  let totalAmount = 0n;
  let withdrawn = 0n;
  let vested = 0n;
  let withdrawable = 0n;

  for (const stream of streams) {
    const streamTotal = BigInt(stream.totalAmount.toString());
    const streamWithdrawn = BigInt(stream.withdrawn.toString());
    const streamVested = vestedAmount(
      streamTotal,
      stream.startTime,
      stream.endTime,
      stream.cliffTime,
      now,
    );
    const streamWithdrawable = withdrawableAmount(streamVested, streamWithdrawn);

    totalAmount += streamTotal;
    withdrawn += streamWithdrawn;
    vested += streamVested;
    withdrawable += streamWithdrawable;
  }

  return {
    count: streams.length,
    totalAmount: totalAmount.toString(),
    total: totalAmount.toString(),
    withdrawn: withdrawn.toString(),
    vested: vested.toString(),
    withdrawable: withdrawable.toString(),
  };
}

export type StreamRoutesOptions = {
  summaryCacheTtlMs?: number;
};

// Mirrors the `querystring` JSON schema on GET /streams below field for
// field, so a parameter renamed in one place without the other is a compile
// error instead of a silently-undefined value at runtime.
interface ListStreamsQuery {
  ids?: string;
  sender?: string;
  recipient?: string;
  token?: string;
  limit?: string;
  offset?: string;
  includeTotal?: string;
  cancelled?: string;
  status?: StreamStatus;
  cursor?: string;
}

export async function streamRoutes(
  app: FastifyInstance,
  opts: StreamRoutesOptions = {},
): Promise<void> {
  const summaryCacheTtlMs = opts.summaryCacheTtlMs ?? DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS;
  let cachedSummary: { payload: SummaryPayload; createdAt: number } | null = null;
  // When a recomputation is already in-flight, all concurrent callers wait on
  // the same Promise instead of each running their own four aggregate queries.
  // A failed computation is never stored; the waiting callers all receive the
  // same rejection so no stale data leaks through.
  let inFlightSummary: Promise<SummaryPayload> | null = null;

  // Ensure the shared schemas are available whether this plugin is registered
  // on a full server (which calls addSchema centrally) or a bare Fastify
  // instance in tests. Fastify deduplicates by $id, so calling addSchema when
  // the schema is already present throws; we guard against that here.
  if (!app.getSchema(STREAM_VIEW_SCHEMA_ID)) app.addSchema(streamViewSchema);
  if (!app.getSchema(STREAM_LIST_RESPONSE_SCHEMA_ID)) app.addSchema(streamListResponseSchema);
  if (!app.getSchema(STREAM_SUMMARY_RESPONSE_SCHEMA_ID)) {
    app.addSchema(streamSummaryResponseSchema);
  }
  if (!app.getSchema(STREAM_EVENT_SCHEMA_ID)) app.addSchema(streamEventSchema);
  if (!app.getSchema(STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID)) {
    app.addSchema(streamEventHistoryResponseSchema);
  }
  if (!app.getSchema(TOKEN_SUMMARY_SCHEMA_ID)) {
    app.addSchema(tokenSummarySchema);
  }
  if (!app.getSchema(TOKEN_LIST_RESPONSE_SCHEMA_ID)) {
    app.addSchema(tokenListResponseSchema);
  }
  if (!app.getSchema(ACCOUNT_STREAM_SUMMARY_SCHEMA_ID)) {
    app.addSchema(accountStreamSummarySchema);
  }
  if (!app.getSchema(ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID)) {
    app.addSchema(accountSummaryResponseSchema);
  }
  if (!app.getSchema(STREAM_SCHEDULE_RESPONSE_SCHEMA_ID)) {
    app.addSchema(streamScheduleResponseSchema);
  }
  if (!app.getSchema(ERROR_SCHEMA_ID)) app.addSchema(apiErrorSchema);

  app.get<{ Querystring: ListStreamsQuery }>(
    "/streams",
    {
      schema: {
        summary: "List streams",
        description:
          "Returns a paginated list of token streams. Optionally filter by sender, recipient, or token address; " +
          "ids accepts up to 100 comma-separated uint64 stream ids; unknown ids are omitted. " +
          "address filters accept lowercase and whitespace-padded spellings and are normalized before matching. " +
          "Use the opaque cursor returned by previous responses for stable pagination under concurrent inserts; " +
          "when cursor is provided, offset is ignored and offset ceiling checks are skipped. " +
          "Results are returned in a stable deterministic order: when filtering by sender, recipient, or token, " +
          "results are ordered by that address ascending, then by stream id descending to break ties. " +
          "Unfiltered queries (or queries filtered only by cancellation status) are ordered by stream id descending. " +
          "Stream id is the final tie-breaker in all cases so pagination is cacheable and repeatable. " +
          "Responses carry a weak ETag derived from the body; send it back as If-None-Match to get a 304 with no body when nothing changed.",
        tags: ["streams"],
        querystring: {
          type: "object",
          properties: {
            ids: {
              type: "string",
              description:
                "Comma-separated uint64 stream ids (1 to 100 entries). Invalid ids or more than 100 entries return 400. " +
                "Unknown ids are omitted and duplicates return one stream. Other filters and pagination still apply; " +
                "use limit=100 to retrieve up to 100 matches in one page.",
              examples: ["1,2,3"],
            },
            sender: {
              type: "string",
              description:
                "Filter by sender Stellar address. Trimmed and uppercased before matching.",
              examples: ["GBLDDFU4L4AUB67M7NDS56VMMW7N6N5Q5T6XQIQG45Q6S6BZYF2K36L7"],
            },
            recipient: {
              type: "string",
              description:
                "Filter by recipient Stellar address. Trimmed and uppercased before matching.",
              examples: ["GBLDDFU4L4AUB67M7NDS56VMMW7N6N5Q5T6XQIQG45Q6S6BZYF2K36L7"],
            },
            token: {
              type: "string",
              description:
                "Filter by token contract Stellar address. Trimmed and uppercased before matching.",
              examples: ["CDLZFC3SYJYDZT7K67VZ75HPJVIEWCEUNGXQZOFQIX22EOCDOB5GQQM6"],
            },
            limit: {
              type: "string",
              description: "Maximum results to return. Capped at 100. Defaults to 50.",
              examples: ["10"],
            },
            offset: {
              type: "string",
              description: `Zero-based offset for pagination. Defaults to 0 and must not exceed ${MAX_OFFSET}.`,
              examples: ["50"],
            },
            includeTotal: {
              type: "string",
              enum: ["true", "false"],
              description:
                "When true, the response includes the total number of streams matching the filters. " +
                "Defaults to false, which skips the count query and omits total from the response.",
              examples: ["true"],
            },
            cancelled: {
              type: "string",
              enum: ["true", "false"],
              description:
                "Filter by cancellation status. Omit to return both cancelled and active streams.",
            },
            status: {
              type: "string",
              enum: ["pending", "streaming", "completed", "cancelled"],
              description:
                "Filter by lifecycle status. pending: not yet started, streaming: currently active, " +
                "completed: ended naturally, cancelled: terminated early. Combines with other filters.",
            },
            cursor: {
              type: "string",
              description:
                "Opaque cursor returned by a previous list response. Use this to fetch the next page " +
                "with stable ordering under concurrent inserts. Takes precedence over offset when both are provided.",
            },
            minAmount: {
              type: "string",
              description: "Filter streams with total amount greater than or equal to this value (non-negative integer string).",
              examples: ["1000000"],
            },
            maxAmount: {
              type: "string",
              description: "Filter streams with total amount less than or equal to this value (non-negative integer string).",
              examples: ["10000000"],
            },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: STREAM_LIST_RESPONSE_SCHEMA_ID },
          304: { type: "null" },
          400: { $ref: ERROR_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const query = request.query;

      const { limit, offset } = parsePagination(query);

      let cursor: bigint | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor);
        if (decoded === null) {
          return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid cursor");
        }
        cursor = decoded;
      }

      const usingCursor = cursor !== undefined;
      if (!usingCursor && offset > MAX_OFFSET) {
        return sendError(
          reply,
          request,
          400,
          "VALIDATION_ERROR",
          `offset must not exceed ${MAX_OFFSET}. Page through results in order with limit and offset, ` +
            "or narrow them with the sender, recipient, and token filters, or use the returned cursor for stable pagination.",
        );
      }

      const filter: {
        ids?: bigint[];
        sender?: string;
        recipient?: string;
        token?: string;
        cancelled?: boolean;
        status?: "pending" | "streaming" | "completed" | "cancelled";
        cursor?: bigint;
        minAmount?: bigint;
        maxAmount?: bigint;
      } = {};
      if (query.ids !== undefined) {
        const parts = query.ids.split(",");
        if (parts.length > 100) {
          return sendError(reply, request, 400, "VALIDATION_ERROR", "ids must contain at most 100 stream ids");
        }
        const ids: bigint[] = [];
        for (const part of parts) {
          const id = parseStreamId(part);
          if (id === null) {
            return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid stream id in ids");
          }
          ids.push(id);
        }
        filter.ids = [...new Set(ids)];
      }
      for (const field of ["sender", "recipient", "token"] as const) {
        const raw = query[field];
        if (!raw) continue;
        const normalized = normalizeAddress(raw);
        if (!normalized) {
          return sendError(reply, request, 400, "VALIDATION_ERROR", `invalid ${field} address`);
        }
        filter[field] = normalized;
      }

      filter.cancelled = parseCancelled(query.cancelled);

      // Parse and validate status filter
      if (query.status) {
        const status = query.status;
        if (status !== "pending" && status !== "streaming" && status !== "completed" && status !== "cancelled") {
          return sendError(reply, request, 400, "VALIDATION_ERROR", "status must be one of: pending, streaming, completed, cancelled");
        }
        filter.status = status;
      }

      filter.cursor = cursor;
      
      // Parse amount filters
      const minAmount = parseAmount(query.minAmount);
      if (query.minAmount !== undefined && minAmount === null) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid minAmount (must be non-negative integer)");
      }
      filter.minAmount = minAmount ?? undefined;
      
      const maxAmount = parseAmount(query.maxAmount);
      if (query.maxAmount !== undefined && maxAmount === null) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid maxAmount (must be non-negative integer)");
      }
      filter.maxAmount = maxAmount ?? undefined;

      const includeTotal = parseIncludeTotal(query.includeTotal);

      const now = nowSeconds();

      const [listResult, total] = await Promise.all([
        filter.status
          ? listStreams({ ...filter, limit, offset }, now)
          : listStreams({ ...filter, limit, offset }),
        includeTotal
          ? filter.status ? countStreams(filter, now) : countStreams(filter)
          : Promise.resolve(undefined),
      ]);

      reply.header("Cache-Control", "public, max-age=30");

      // Built once and reused for both the ETag and the returned body so the
      // digest is derived from exactly the bytes the client would receive.
      const body = {
        streams: listResult.streams.map((s) => mapStreamResponse(s)),
        ...(total === undefined ? {} : { total }),
        ...(listResult.nextCursor === undefined ? {} : { nextCursor: listResult.nextCursor }),
        limit,
        offset: usingCursor ? 0 : offset,
      };

      const etag = weakEtagFromBody(body);
      reply.header("ETag", etag);

      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).send();
      }

      return body;
    },
  );

  app.get(
    "/streams/summary",
    {
      schema: {
        summary: "Summarize streams by status",
        description:
          "Returns counts and exact amount totals for each lifecycle status across all indexed streams. " +
          "Totals are aggregated in the database over decimal columns, so they never lose precision.",
        tags: ["streams"],
        response: {
          200: { $ref: STREAM_SUMMARY_RESPONSE_SCHEMA_ID },
        },
      },
    },
    async (_request, reply) => {
      const requestTimeMs = Date.now();
      if (summaryCacheTtlMs > 0 && cachedSummary !== null) {
        const ageMs = requestTimeMs - cachedSummary.createdAt;
        if (ageMs >= 0 && ageMs < summaryCacheTtlMs) {
          const maxAgeSeconds = Math.floor((summaryCacheTtlMs - ageMs) / 1000);
          reply.header("Cache-Control", `public, max-age=${maxAgeSeconds}`);
          return cachedSummary.payload;
        }
      }

      // If another request is already computing the summary, share its result
      // instead of running a duplicate set of aggregate queries.
      if (inFlightSummary !== null) {
        const payload = await inFlightSummary;
        const ageMs = Date.now() - (cachedSummary?.createdAt ?? 0);
        const maxAgeSeconds = Math.max(0, Math.floor((summaryCacheTtlMs - ageMs) / 1000));
        reply.header("Cache-Control", `public, max-age=${maxAgeSeconds}`);
        return payload;
      }

      // This request is the first to notice the cache is stale — it owns the
      // computation. Build the promise, store it so concurrent arrivals can
      // attach, then await it ourselves.
      const compute = async (): Promise<SummaryPayload> => {
        const now = nowSeconds();
        const entries = await Promise.all(
          SUMMARY_STATUSES.map(async (status) => {
            const aggregate = await aggregateStreams(statusWhere(status, now));
            return [
              status,
              {
                count: aggregate.count,
                totalAmount: aggregate.totalAmount.toString(),
                withdrawn: aggregate.withdrawn.toString(),
              },
            ] as const;
          }),
        );
        return Object.fromEntries(entries) as SummaryPayload;
      };

      inFlightSummary = compute();
      try {
        const payload = await inFlightSummary;
        const createdAt = Date.now();
        if (summaryCacheTtlMs > 0) cachedSummary = { payload, createdAt };
        reply.header(
          "Cache-Control",
          `public, max-age=${Math.floor(summaryCacheTtlMs / 1000)}`,
        );
        return payload;
      } finally {
        // Always clear the in-flight slot so the next expiry triggers a fresh
        // computation. On failure this ensures no stale promise is reused.
        inFlightSummary = null;
      }
    },
  );

  app.get(
    "/tokens",
    {
      schema: {
        summary: "List distinct tokens",
        description:
          "Returns each distinct token with its stream count and total escrowed amount. " +
          "Totals are aggregated in the database over decimal columns, so they never lose precision.",
        tags: ["streams"],
        response: {
          200: { $ref: TOKEN_LIST_RESPONSE_SCHEMA_ID },
        },
      },
    },
    async (_request, reply) => {
      const tokens = await listTokens();
      reply.header("Cache-Control", "public, max-age=30");
      return tokens;
    },
  );

  app.get(
    "/streams/:id/events",
    {
      schema: {
        summary: "Get stream event history",
        description:
          "Returns the indexed event history for a single stream in ascending chain order. " +
          "The event ids are TOID-index values, so the array is deterministic and replay-safe.",
        tags: ["streams"],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: {
              type: "string",
              description: "Stream id (uint64, decimal string).",
              examples: ["42"],
            },
          },
        },
        querystring: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["created", "withdrawn", "cancelled"],
              description: "Filter events by kind (created, withdrawn, or cancelled).",
            },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID },
          400: { $ref: ERROR_SCHEMA_ID },
          404: { $ref: ERROR_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { kind } = (request.query as { kind?: string }) ?? {};
      const streamId = parseStreamId(id);
      if (streamId === null) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid stream id");
      }

      const validKinds: readonly string[] = ["created", "withdrawn", "cancelled"];
      if (kind !== undefined && !validKinds.includes(kind)) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid event kind");
      }

      const stream = await getStream({ streamId });
      if (!stream) {
        return sendError(reply, request, 404, "NOT_FOUND", "stream not found");
      }

      const events = await listIndexedEvents(streamId, kind as IndexedEventKind | undefined);
      reply.header("Cache-Control", "public, max-age=30");
      return events.map((event) => ({
        eventId: event.eventId,
        kind: event.kind,
        streamId: event.streamId,
        ledger: event.ledger,
        txHash: event.txHash,
        sender: event.sender ?? null,
        recipient: event.recipient ?? null,
        token: event.token ?? null,
        totalAmount: bigIntToStringNullable(event.totalAmount),
        amount: bigIntToStringNullable(event.amount),
        recipientAmount: bigIntToStringNullable(event.recipientAmount),
        senderRefund: bigIntToStringNullable(event.senderRefund),
        startTime: bigIntToStringNullable(event.startTime),
        endTime: bigIntToStringNullable(event.endTime),
        cliffTime: bigIntToStringNullable(event.cliffTime),
        closedAt: bigIntToStringNullable(event.closedAt),
      }));
    },
  );

  app.get(
    "/streams/:id",
    {
      exposeHeadRoute: true,
      schema: {
        summary: "Get stream by id",
        description: "Returns a single token stream by its numeric id.",
        tags: ["streams"],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: {
              type: "string",
              description: "Stream id (uint64, decimal string).",
              examples: ["42"],
            },
          },
        },
        querystring: {
          type: "object",
          properties: {
            at: {
              type: "string",
              description:
                "Optional Unix timestamp in seconds to calculate vested/derived figures at that point in time.",
              examples: ["1735689600"],
            },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: STREAM_VIEW_SCHEMA_ID },
          304: { type: "null" },
          400: { $ref: ERROR_SCHEMA_ID },
          404: { $ref: ERROR_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const streamId = parseStreamId(id);
      if (streamId === null) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid stream id");
      }

      const query = request.query as { at?: string };
      let asOfTime: bigint | undefined;
      if (query.at !== undefined) {
        const parsed = parseAtTimestamp(query.at);
        if (parsed === null) {
          return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid at timestamp");
        }
        asOfTime = parsed;
      }

      const stream = await getStream({ streamId });
      if (!stream) {
        return sendError(reply, request, 404, "NOT_FOUND", "stream not found");
      }

      const etag =
        asOfTime !== undefined
          ? `"${stream.updatedLedger}-${asOfTime}"`
          : `"${stream.updatedLedger}"`;
      reply.header("Cache-Control", "public, max-age=30");
      reply.header("ETag", etag);

      const ifNoneMatch = request.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        return reply.code(304).send();
      }

      return mapStreamResponse(stream, asOfTime);
    },
  );

  app.get(
    "/streams/:id/schedule",
    {
      schema: {
        summary: "Get stream vesting schedule",
        description:
          "Returns evenly spaced points along the stream's vesting curve between start and end, " +
          "with the cliff step included, suitable for client-side charting.",
        tags: ["streams"],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: {
              type: "string",
              description: "Stream id (uint64, decimal string).",
              examples: ["42"],
            },
          },
        },
        querystring: {
          type: "object",
          properties: {
            points: {
              type: "string",
              description: "Desired number of schedule points (2–100, default 50).",
              examples: ["50"],
            },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: STREAM_SCHEDULE_RESPONSE_SCHEMA_ID },
          304: { type: "null" },
          400: { $ref: ERROR_SCHEMA_ID },
          404: { $ref: ERROR_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const streamId = parseStreamId(id);
      if (streamId === null) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid stream id");
      }

      const query = request.query as { points?: string; count?: string; limit?: string };
      const rawPoints = query.points ?? query.count ?? query.limit;
      let requestedPoints = DEFAULT_SCHEDULE_POINTS;
      if (rawPoints !== undefined) {
        const trimmed = rawPoints.trim();
        if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
          return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid points parameter");
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid points parameter");
        }
        requestedPoints = Math.max(MIN_SCHEDULE_POINTS, Math.min(parsed, MAX_SCHEDULE_POINTS));
      }

      const stream = await getStream({ streamId });
      if (!stream) {
        return sendError(reply, request, 404, "NOT_FOUND", "stream not found");
      }

      const etag = `"${stream.updatedLedger}-schedule-${requestedPoints}"`;
      reply.header("Cache-Control", "public, max-age=30");
      reply.header("ETag", etag);

      const ifNoneMatch = request.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        return reply.code(304).send();
      }

      const points = computeSchedulePoints(stream, requestedPoints);
      return { points };
    },
  );

  app.get(
    "/accounts/:address/summary",
    {
      schema: {
        summary: "Get account stream summary",
        description:
          "Returns incoming and outgoing stream counts and exact amount totals for a single Stellar address. " +
          "Derived amounts (vested, withdrawable) are calculated against the current time using the same rules as the stream view.",
        tags: ["streams"],
        params: {
          type: "object",
          required: ["address"],
          properties: {
            address: {
              type: "string",
              description: "Stellar account public key or contract address.",
              examples: ["GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
            },
          },
        },
        response: {
          200: { $ref: ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID },
          400: { $ref: ERROR_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params as { address: string };
      const normalized = normalizeAddress(address);
      if (!normalized) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid address");
      }

      const { incoming, outgoing } = await getAccountStreams(normalized);
      const now = nowSeconds();

      reply.header("Cache-Control", "public, max-age=30");
      return {
        incoming: summarizeAccountStreams(incoming, now),
        outgoing: summarizeAccountStreams(outgoing, now),
      };
    },
  );
}
