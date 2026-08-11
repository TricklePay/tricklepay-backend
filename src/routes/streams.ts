import type { FastifyInstance } from "fastify";
import type { Stream } from "@prisma/client";
import { countStreams, getStream, listStreams } from "../repositories/streams.js";
import { vestedAmount, withdrawableAmount } from "../lib/vesting.js";
import {
  apiErrorSchema,
  ERROR_SCHEMA_ID,
  streamListResponseSchema,
  STREAM_LIST_RESPONSE_SCHEMA_ID,
  streamViewSchema,
  STREAM_VIEW_SCHEMA_ID,
} from "../schema.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

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

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  // Ensure the shared schemas are available whether this plugin is registered
  // on a full server (which calls addSchema centrally) or a bare Fastify
  // instance in tests. Fastify deduplicates by $id, so calling addSchema when
  // the schema is already present throws; we guard against that here.
  if (!app.getSchema(STREAM_VIEW_SCHEMA_ID)) app.addSchema(streamViewSchema);
  if (!app.getSchema(STREAM_LIST_RESPONSE_SCHEMA_ID)) app.addSchema(streamListResponseSchema);
  if (!app.getSchema(ERROR_SCHEMA_ID)) app.addSchema(apiErrorSchema);

  app.get(
    "/streams",
    {
      schema: {
        summary: "List streams",
        description:
          "Returns a paginated list of token streams. Optionally filter by sender, recipient, or token address.",
        tags: ["streams"],
        querystring: {
          type: "object",
          properties: {
            sender: {
              type: "string",
              description: "Filter by sender Stellar address.",
            },
            recipient: {
              type: "string",
              description: "Filter by recipient Stellar address.",
            },
            token: {
              type: "string",
              description: "Filter by token contract Stellar address.",
            },
            limit: {
              type: "string",
              description: `Maximum results to return. Capped at ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
            },
            offset: {
              type: "string",
              description: "Zero-based offset for pagination. Defaults to 0.",
            },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: STREAM_LIST_RESPONSE_SCHEMA_ID },
        },
      },
    },
    async (request) => {
      const query = request.query as {
        sender?: string;
        recipient?: string;
        token?: string;
        limit?: string;
        offset?: string;
      };

      const limit = parseLimit(query.limit);
      const offset = parseOffset(query.offset);
      const filter = {
        sender: query.sender,
        recipient: query.recipient,
        token: query.token,
      };

      const [streams, total] = await Promise.all([
        listStreams({ ...filter, limit, offset }),
        countStreams(filter),
      ]);

      return { streams: streams.map(toView), total, limit, offset };
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
        return reply.code(400).send({ error: "invalid stream id" });
      }

      const stream = await getStream(streamId);
      if (!stream) {
        return reply.code(404).send({ error: "stream not found" });
      }

      return toView(stream);
    },
  );
}
