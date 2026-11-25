// GET /streams/:id: a single stream, optionally evaluated at a given time.

import type { FastifyInstance } from "fastify";

import { QueryTimeoutError } from "../../db.js";
import { ifNoneMatchMatches, strongEtag } from "../../lib/etag.js";
import { sendError } from "../../lib/response.js";
import { isStreamIdOutOfRange, parseStreamId } from "../../lib/stream-id.js";
import { parseAtTimestamp } from "../../lib/stream-query.js";
import { mapStreamResponse, parseFields } from "../../lib/stream-view.js";
import { getStream } from "../../repositories/streams.js";
import {
  ERROR_SCHEMA_ID,
  RATE_LIMITED_RESPONSE_SCHEMA_ID,
  SERVER_ERROR_RESPONSE_SCHEMA_ID,
  STREAM_VIEW_SCHEMA_ID,
} from "../../schema.js";

export function registerStreamDetailRoute(app: FastifyInstance): void {
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
            fields: {
              type: "string",
              description: "Comma-separated list of fields to include in the response. Valid fields: id, sender, recipient, token, totalAmount, withdrawn, vested, withdrawable, locked, progress, startTime, endTime, cliffTime, cancelled, status, createdLedger, updatedLedger. Omit to return all fields.",
              examples: ["id,status,withdrawable"],
            },
          },
          additionalProperties: false,
        },
        response: {
          200: { $ref: STREAM_VIEW_SCHEMA_ID },
          304: { type: "null" },
          400: { $ref: ERROR_SCHEMA_ID },
          404: { $ref: ERROR_SCHEMA_ID },
          429: { $ref: RATE_LIMITED_RESPONSE_SCHEMA_ID },
          500: { $ref: SERVER_ERROR_RESPONSE_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const streamId = parseStreamId(id);
      if (streamId === null) {
        if (isStreamIdOutOfRange(id)) {
          return sendError(reply, request, 404, "NOT_FOUND", "stream not found");
        }
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid stream id");
      }

      const query = request.query as { at?: string; fields?: string };
      let asOfTime: bigint | undefined;
      if (query.at !== undefined) {
        const parsed = parseAtTimestamp(query.at);
        if (parsed === null) {
          return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid at timestamp");
        }
        asOfTime = parsed;
      }

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

      const etag =
        asOfTime !== undefined
          ? strongEtag(stream.updatedLedger, asOfTime, query.fields)
          : strongEtag(stream.updatedLedger, undefined, query.fields);
      reply.header("Cache-Control", "public, max-age=30");
      reply.header("ETag", etag);

      if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
        return reply.code(304).send();
      }

      return mapStreamResponse(stream, asOfTime, fields);
    },
  );
}
