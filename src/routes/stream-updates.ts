// Server-Sent Events endpoint for real-time stream updates.
// Clients can subscribe to GET /streams/:id/updates to receive a stream of
// events as the indexer applies them, removing the need to poll the detail
// endpoint for withdrawals and cancellations.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getStream } from "../repositories/streams.js";
import { sendError } from "../lib/response.js";
import { streamEventBus, type StreamUpdateEvent } from "../event-bus.js";
import { toView } from "../lib/stream-view.js";
import {
  rateLimitedResponseSchema,
  RATE_LIMITED_RESPONSE_SCHEMA_ID,
  serverErrorResponseSchema,
  SERVER_ERROR_RESPONSE_SCHEMA_ID,
} from "../schema.js";

const MAX_UINT64 = 18446744073709551615n;

function parseStreamId(raw: string | undefined): bigint | null {
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

// Maximum concurrent SSE connections per instance to prevent resource exhaustion
const MAX_SSE_CONNECTIONS = 1000;

// Connection timeout: close idle connections after 5 minutes
const SSE_TIMEOUT_MS = 5 * 60 * 1000;

// Heartbeat interval: send keepalive comments every 30 seconds
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

let activeConnections = 0;

export async function streamUpdateRoutes(app: FastifyInstance): Promise<void> {
  if (!app.getSchema(RATE_LIMITED_RESPONSE_SCHEMA_ID)) app.addSchema(rateLimitedResponseSchema);
  if (!app.getSchema(SERVER_ERROR_RESPONSE_SCHEMA_ID)) app.addSchema(serverErrorResponseSchema);

  app.get(
    "/streams/:id/updates",
    {
      schema: {
        summary: "Subscribe to stream updates",
        description:
          "Server-Sent Events endpoint that emits an event each time the indexer applies a withdrawal or cancellation " +
          "to the specified stream. Each event carries the updated stream view (with real-time vested/withdrawable amounts) " +
          "and the event kind. Connections are limited, time out after 5 minutes of inactivity, and are closed gracefully on shutdown. " +
          "The client should reconnect if the connection is closed.",
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
          200: {
            description: "Server-Sent Events stream. Each event has type 'update' and carries the stream view as JSON data.",
            type: "string",
            headers: {
              "Content-Type": {
                type: "string",
                enum: ["text/event-stream"],
              },
              "Cache-Control": {
                type: "string",
                enum: ["no-cache, no-transform"],
              },
              "Connection": {
                type: "string",
                enum: ["keep-alive"],
              },
              "X-Accel-Buffering": {
                type: "string",
                enum: ["no"],
              },
            },
          },
          400: {
            type: "object",
            properties: {
              code: { type: "string" },
              error: { type: "string" },
              requestId: { type: "string" },
            },
          },
          404: {
            type: "object",
            properties: {
              code: { type: "string" },
              error: { type: "string" },
              requestId: { type: "string" },
            },
          },
          429: {
            $ref: RATE_LIMITED_RESPONSE_SCHEMA_ID,
          },
          500: {
            $ref: SERVER_ERROR_RESPONSE_SCHEMA_ID,
          },
          503: {
            type: "object",
            properties: {
              code: { type: "string" },
              error: { type: "string" },
              requestId: { type: "string" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const streamId = parseStreamId(id);
      if (streamId === null) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid stream id");
      }

      // Verify the stream exists before opening the SSE connection
      const stream = await getStream({ streamId });
      if (!stream) {
        return sendError(reply, request, 404, "NOT_FOUND", "stream not found");
      }

      // Enforce connection limit
      if (activeConnections >= MAX_SSE_CONNECTIONS) {
        return sendError(
          reply,
          request,
          503,
          "REQUEST_ERROR",
          "server at capacity — too many active SSE connections",
        );
      }

      activeConnections += 1;
      request.log.info({ streamId: streamId.toString() }, "SSE connection opened");

      // Set SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
      });

      // Send initial comment to establish the connection
      reply.raw.write(": connected\n\n");

      let timeoutHandle: NodeJS.Timeout | null = null;
      let heartbeatHandle: NodeJS.Timeout | null = null;
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;

        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        unsubscribe();
        activeConnections -= 1;
        request.log.info({ streamId: streamId.toString() }, "SSE connection closed");
      };

      const resetTimeout = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => {
          request.log.info({ streamId: streamId.toString() }, "SSE connection timed out");
          reply.raw.end();
        }, SSE_TIMEOUT_MS);
      };

      // Set initial timeout
      resetTimeout();

      // Send heartbeat comments to keep the connection alive
      heartbeatHandle = setInterval(() => {
        if (!reply.raw.destroyed) {
          reply.raw.write(": heartbeat\n\n");
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Subscribe to stream updates
      const unsubscribe = streamEventBus.onStreamUpdate(streamId, (update: StreamUpdateEvent) => {
        if (reply.raw.destroyed) {
          cleanup();
          return;
        }

        try {
          // Fetch the current stream state to include live vested/withdrawable amounts
          getStream({ streamId: update.streamId })
            .then((currentStream) => {
              if (!currentStream || reply.raw.destroyed) return;

              const view = toView(currentStream);
              const eventData = {
                kind: update.kind,
                stream: view,
              };

              // Send SSE event
              reply.raw.write(`event: update\n`);
              reply.raw.write(`data: ${JSON.stringify(eventData)}\n\n`);

              // Reset timeout on each event
              resetTimeout();
            })
            .catch((err) => {
              request.log.error({ err, streamId: streamId.toString() }, "failed to fetch stream for SSE");
            });
        } catch (err) {
          request.log.error({ err, streamId: streamId.toString() }, "failed to send SSE event");
          reply.raw.end();
        }
      });

      // Clean up when client disconnects
      request.raw.on("close", cleanup);
      request.raw.on("error", cleanup);

      // Keep the connection open
      await new Promise<void>((resolve) => {
        reply.raw.on("close", resolve);
        reply.raw.on("finish", resolve);
      });
    },
  );
}
