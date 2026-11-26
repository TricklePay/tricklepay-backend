// GET /streams/:id/schedule: points along a stream's vesting curve.

import type { FastifyInstance } from "fastify";

import { QueryTimeoutError } from "../../db.js";
import { ifNoneMatchMatches, strongEtag } from "../../lib/etag.js";
import { sendError } from "../../lib/response.js";
import { isStreamIdOutOfRange, parseStreamId } from "../../lib/stream-id.js";
import {
  computeSchedulePoints,
  DEFAULT_SCHEDULE_POINTS,
  MAX_SCHEDULE_POINTS,
  MIN_SCHEDULE_POINTS,
} from "../../lib/stream-schedule.js";
import { getStream } from "../../repositories/streams.js";
import { ERROR_SCHEMA_ID, STREAM_SCHEDULE_RESPONSE_SCHEMA_ID } from "../../schema.js";

export function registerStreamScheduleRoute(app: FastifyInstance): void {
  app.get(
    "/streams/:id/schedule",
    {
      schema: {
        summary: "Get stream vesting schedule",
        description:
          "Returns evenly spaced points along the stream's vesting curve between start and end, " +
          "with the cliff step included, suitable for client-side charting. " +
          "Points outside 2–100 are rejected with 400.",
        tags: ["streams"],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: {
              type: "integer",
              minimum: MIN_SCHEDULE_POINTS,
              maximum: MAX_SCHEDULE_POINTS,
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
        if (isStreamIdOutOfRange(id)) {
          return sendError(reply, request, 404, "NOT_FOUND", "stream not found");
        }
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid stream id");
      }

      const query = request.query as { points?: number };
      const requestedPoints = query.points ?? DEFAULT_SCHEDULE_POINTS;

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

      const etag = strongEtag(stream.updatedLedger, "schedule", requestedPoints);
      reply.header("Cache-Control", "public, max-age=30");
      reply.header("ETag", etag);

      if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
        return reply.code(304).send();
      }

      const points = computeSchedulePoints(stream, requestedPoints);
      return { points };
    },
  );
}
