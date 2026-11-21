// GET /streams/:id/events: the indexed event history of one stream.

import type { FastifyInstance } from "fastify";

import { QueryTimeoutError } from "../../db.js";
import { bigIntToStringNullable, sendError } from "../../lib/response.js";
import { parseStreamId } from "../../lib/stream-id.js";
import { listIndexedEvents, type IndexedEventKind } from "../../repositories/indexed-events.js";
import { getStream } from "../../repositories/streams.js";
import { ERROR_SCHEMA_ID, STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID } from "../../schema.js";

export function registerStreamEventsRoute(app: FastifyInstance): void {
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

      let stream;
      try {
        stream = await getStream({ streamId });
      } catch (err) {
        if (err instanceof QueryTimeoutError) {
          return sendError(reply, request, 500, "INTERNAL_SERVER_ERROR", "internal server error");
        }
        throw err;
      }
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
}
