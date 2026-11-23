// GET /streams: paginated, filtered list of streams with a weak ETag.

import type { FastifyInstance } from "fastify";

import { sendError } from "../../lib/response.js";
import { ifNoneMatchMatches, weakEtagFromBody } from "../../lib/etag.js";
import { parsePagination } from "../../lib/pagination.js";
import { mapStreamResponse, parseFields } from "../../lib/stream-view.js";
import { parseStreamId } from "../../lib/stream-id.js";
import {
  parseAmount,
  parseCancelled,
  parseIncludeTotal,
} from "../../lib/stream-query.js";
import { normalizeAddress } from "../../lib/address.js";
import { nowSeconds } from "../../lib/time.js";
import { countStreams, decodeCursor, listStreams } from "../../repositories/streams.js";
import { ERROR_SCHEMA_ID, STREAM_LIST_RESPONSE_SCHEMA_ID } from "../../schema.js";

// Above this offset a scan gets expensive enough that callers should page
// through results in order or narrow them with filters instead.
const MAX_OFFSET = 10000;

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

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
  minAmount?: string;
  maxAmount?: string;
  fields?: string;
}

export function registerListStreamsRoute(app: FastifyInstance): void {
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
            fields: {
              type: "string",
              description: "Comma-separated list of fields to include in each stream object. Valid fields: id, sender, recipient, token, totalAmount, withdrawn, vested, withdrawable, locked, progress, startTime, endTime, cliffTime, cancelled, status, createdLedger, updatedLedger. Omit to return all fields.",
              examples: ["id,status,withdrawable"],
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

      // Parse and validate fields parameter
      const fields = parseFields(query.fields);
      if (query.fields !== undefined && fields === null) {
        return sendError(
          reply,
          request,
          400,
          "VALIDATION_ERROR",
          "invalid fields parameter: one or more field names are not recognized",
        );
      }

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
        streams: listResult.streams.map((s) => mapStreamResponse(s, undefined, fields)),
        ...(total === undefined ? {} : { total }),
        ...(listResult.nextCursor === undefined ? {} : { nextCursor: listResult.nextCursor }),
        limit,
        offset: usingCursor ? 0 : offset,
      };

      // ETag includes the fields selection so different field sets get different tags
      const etagInput = query.fields
        ? { ...body, _fields: query.fields }
        : body;
      const etag = weakEtagFromBody(etagInput);
      reply.header("ETag", etag);

      if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
        return reply.code(304).send();
      }

      return body;
    },
  );
}
