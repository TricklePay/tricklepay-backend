import type { FastifyInstance } from "fastify";
import { Prisma, type Stream } from "@prisma/client";
import { StrKey } from "@stellar/stellar-sdk";
import {
  aggregateStreams,
  countStreams,
  decodeCursor,
  getStream,
  listStreams,
} from "../repositories/streams.js";
import { vestedAmount, withdrawableAmount } from "../lib/vesting.js";
import {
  apiErrorSchema,
  ERROR_SCHEMA_ID,
  streamListResponseSchema,
  STREAM_LIST_RESPONSE_SCHEMA_ID,
  streamSummaryResponseSchema,
  STREAM_SUMMARY_RESPONSE_SCHEMA_ID,
  streamViewSchema,
  STREAM_VIEW_SCHEMA_ID,
} from "../schema.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
// Above this offset a scan gets expensive enough that callers should page
// through results in order or narrow them with filters instead.
const MAX_OFFSET = 10000;

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function statusOf(stream: Stream, now: bigint): StreamStatus {
  if (stream.cancelled) return "cancelled";
  if (now < stream.startTime) return "pending";
  if (now >= stream.endTime) return "completed";
  return "streaming";
}

// Shapes a stored stream into the API response, computing vested and
// withdrawable amounts against the current clock so clients see live figures
// without querying the chain.
function toView(stream: Stream) {
  const now = nowSeconds();
  const total = BigInt(stream.totalAmount.toString());
  const withdrawn = BigInt(stream.withdrawn.toString());
  const vested = vestedAmount(total, stream.startTime, stream.endTime, stream.cliffTime, now);
  const withdrawable = withdrawableAmount(vested, withdrawn);
  const locked = total - vested;
  // Vesting progress in basis points, from 0 to 10000, matching the contract.
  const progress = total === 0n ? 10000 : Number((vested * 10000n) / total);

  return {
    id: stream.streamId.toString(),
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    totalAmount: total.toString(),
    withdrawn: withdrawn.toString(),
    vested: vested.toString(),
    withdrawable: withdrawable.toString(),
    locked: locked.toString(),
    progress,
    startTime: stream.startTime.toString(),
    endTime: stream.endTime.toString(),
    cliffTime: stream.cliffTime.toString(),
    cancelled: stream.cancelled,
    status: statusOf(stream, now),
  };
}

function parseLimit(raw: string | undefined): number {
  const value = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function parseOffset(raw: string | undefined): number {
  const value = raw ? Number(raw) : 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function parseIncludeTotal(raw: string | undefined): boolean {
  return raw === "true";
}

function parseCancelled(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

// Stellar addresses are canonical uppercase base32 strkeys, but callers
// sometimes send lowercase or whitespace-padded spellings. Normalize those
// before matching so every rendering of one address filters identically, and
// reject values that are neither a valid account nor a valid contract address.
// Returns null when the input cannot be normalized safely.
function normalizeAddress(raw: string): string | null {
  const candidate = raw.trim().toUpperCase();
  if (StrKey.isValidEd25519PublicKey(candidate) || StrKey.isValidContract(candidate)) {
    return candidate;
  }
  return null;
}

const SUMMARY_STATUSES = ["pending", "streaming", "completed", "cancelled"] as const;

// The database-side predicate for each lifecycle status, mirroring `statusOf`:
// cancelled wins first, then the start/end time windows against the clock.
function statusWhere(status: StreamStatus, now: bigint): Prisma.StreamWhereInput {
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

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  // Ensure the shared schemas are available whether this plugin is registered
  // on a full server (which calls addSchema centrally) or a bare Fastify
  // instance in tests. Fastify deduplicates by $id, so calling addSchema when
  // the schema is already present throws; we guard against that here.
  if (!app.getSchema(STREAM_VIEW_SCHEMA_ID)) app.addSchema(streamViewSchema);
  if (!app.getSchema(STREAM_LIST_RESPONSE_SCHEMA_ID)) app.addSchema(streamListResponseSchema);
  if (!app.getSchema(STREAM_SUMMARY_RESPONSE_SCHEMA_ID)) {
    app.addSchema(streamSummaryResponseSchema);
  }
  if (!app.getSchema(ERROR_SCHEMA_ID)) app.addSchema(apiErrorSchema);

  app.get(
    "/streams",
    {
      schema: {
        summary: "List streams",
        description:
          "Returns a paginated list of token streams. Optionally filter by sender, recipient, or token address; " +
          "address filters accept lowercase and whitespace-padded spellings and are normalized before matching. " +
          "Use the opaque cursor returned by previous responses for stable pagination under concurrent inserts; " +
          "when cursor is provided, offset is ignored and offset ceiling checks are skipped.",
        tags: ["streams"],
        querystring: {
          type: "object",
          properties: {
            sender: {
              type: "string",
              description:
                "Filter by sender Stellar address. Trimmed and uppercased before matching.",
            },
            recipient: {
              type: "string",
              description:
                "Filter by recipient Stellar address. Trimmed and uppercased before matching.",
            },
            token: {
              type: "string",
              description:
                "Filter by token contract Stellar address. Trimmed and uppercased before matching.",
            },
            limit: {
              type: "string",
              description: `Maximum results to return. Capped at ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
            },
            offset: {
              type: "string",
              description: `Zero-based offset for pagination. Defaults to 0 and must not exceed ${MAX_OFFSET}. Ignored when cursor is provided.`,
            },
            includeTotal: {
              type: "string",
              enum: ["true", "false"],
              description:
                "When true, the response includes the total number of streams matching the filters. " +
                "Defaults to false, which skips the count query and omits total from the response.",
            },
            cancelled: {
              type: "string",
              enum: ["true", "false"],
              description:
                "Filter by cancellation status. Omit to return both cancelled and active streams.",
            },
            cursor: {
              type: "string",
              description:
                "Opaque cursor returned by a previous list response. Use this to fetch the next page " +
                "with stable ordering under concurrent inserts. Takes precedence over offset when both are provided.",
            },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: STREAM_LIST_RESPONSE_SCHEMA_ID },
          400: { $ref: ERROR_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as {
        sender?: string;
        recipient?: string;
        token?: string;
        limit?: string;
        offset?: string;
        includeTotal?: string;
        cancelled?: string;
        cursor?: string;
      };

      const limit = parseLimit(query.limit);
      const offset = parseOffset(query.offset);

      let cursor: bigint | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor);
        if (decoded === null) {
          return reply.code(400).send({
            code: "VALIDATION_ERROR",
            error: "invalid cursor",
            requestId: request.id,
          });
        }
        cursor = decoded;
      }

      const usingCursor = cursor !== undefined;
      if (!usingCursor && offset > MAX_OFFSET) {
        return reply.code(400).send({
          code: "VALIDATION_ERROR",
          error:
            `offset must not exceed ${MAX_OFFSET}. Page through results in order with limit and offset, ` +
            "or narrow them with the sender, recipient, and token filters, or use the returned cursor for stable pagination.",
          requestId: request.id,
        });
      }

      const filter: {
        sender?: string;
        recipient?: string;
        token?: string;
        cancelled?: boolean;
        cursor?: bigint;
      } = {};
      for (const field of ["sender", "recipient", "token"] as const) {
        const raw = query[field];
        if (!raw) continue;
        const normalized = normalizeAddress(raw);
        if (!normalized) {
          return reply.code(400).send({
            code: "VALIDATION_ERROR",
            error: `invalid ${field} address`,
            requestId: request.id,
          });
        }
        filter[field] = normalized;
      }

      filter.cancelled = parseCancelled(query.cancelled);
      filter.cursor = cursor;

      const includeTotal = parseIncludeTotal(query.includeTotal);

      const [listResult, total] = await Promise.all([
        listStreams({ ...filter, limit, offset }),
        includeTotal ? countStreams(filter) : Promise.resolve(undefined),
      ]);

      reply.header("Cache-Control", "public, max-age=30");
      return {
        streams: listResult.streams.map(toView),
        ...(total === undefined ? {} : { total }),
        ...(listResult.nextCursor === undefined ? {} : { nextCursor: listResult.nextCursor }),
        limit,
        offset: usingCursor ? 0 : offset,
      };
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

      reply.header("Cache-Control", "public, max-age=30");
      return Object.fromEntries(entries);
    },
  );

  app.get(
    "/streams/:id",
    {
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

      let streamId: bigint;
      try {
        streamId = BigInt(id);
      } catch {
        return reply.code(400).send({
          code: "VALIDATION_ERROR",
          error: "invalid stream id",
          requestId: request.id,
        });
      }

      const stream = await getStream(streamId);
      if (!stream) {
        return reply.code(404).send({
          code: "NOT_FOUND",
          error: "stream not found",
          requestId: request.id,
        });
      }

      const etag = `"${stream.updatedLedger}"`;
      reply.header("Cache-Control", "public, max-age=30");
      reply.header("ETag", etag);

      const ifNoneMatch = request.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        return reply.code(304).send();
      }

      return toView(stream);
    },
  );
}
