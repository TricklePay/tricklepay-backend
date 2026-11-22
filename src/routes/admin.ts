// Registers administrative endpoints that require authentication.
//
// POST /admin/replay triggers a failed event replay. It is disabled unless
// ADMIN_TOKEN is configured; when enabled, it requires a matching Bearer token
// in the Authorization header.
//
// Only one replay can run at a time; concurrent requests receive 409 Conflict.

import type { FastifyInstance, FastifyRequest } from "fastify";

import { rpc } from "@stellar/stellar-sdk";

import type { Config } from "../config.js";

import { replayFailedEvents, type ReplayFailedEventsSummary } from "../indexer/replay.js";

import { createRpcServer } from "../chain/rpc.js";

// Tracks whether a replay is currently running to prevent concurrent runs.
let replayInProgress = false;

// Request body schema for POST /admin/replay
interface ReplayRequestBody {
  limit?: number;
  dryRun?: boolean;
}

export function adminRoutes(config: Config) {
  return async (app: FastifyInstance): Promise<void> => {
    // Admin endpoints are only registered when an admin token is configured.
    if (!config.adminToken) {
      return;
    }

    const server = createRpcServer(config);

    app.post<{ Body: ReplayRequestBody }>(
      "/admin/replay",
      {
        schema: {
          summary: "Trigger failed event replay (admin)",
          description:
            "Retries a bounded batch of failed events. Requires Bearer authentication. " +
            "Only one replay can run at a time; concurrent requests receive 409 Conflict.",
          tags: ["admin"],
          security: [{ bearerAuth: [] }],
          body: {
            type: "object",
            properties: {
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 1000,
                default: 20,
                description: "Maximum number of failed events to retry. Default 20.",
              },
              dryRun: {
                type: "boolean",
                default: false,
                description: "When true, simulates replay without modifying the database.",
              },
            },
          },
          response: {
            200: {
              type: "object",
              required: ["attempted", "succeeded", "failed", "dryRun"],
              properties: {
                attempted: {
                  type: "integer",
                  description: "Total number of failed events processed.",
                },
                succeeded: {
                  type: "integer",
                  description: "Number of events that replayed successfully.",
                },
                failed: {
                  type: "integer",
                  description: "Number of events that failed again.",
                },
                dryRun: {
                  type: "boolean",
                  description: "Whether this was a dry run (no database changes).",
                },
              },
            },
            401: {
              type: "object",
              required: ["code", "error", "requestId"],
              properties: {
                code: { type: "string", enum: ["REQUEST_ERROR"] },
                error: { type: "string" },
                requestId: { type: "string" },
              },
            },
            409: {
              type: "object",
              required: ["code", "error", "requestId"],
              properties: {
                code: { type: "string", enum: ["REQUEST_ERROR"] },
                error: { type: "string" },
                requestId: { type: "string" },
              },
            },
          },
        },
      },
      async (request, reply) => {
        // Verify bearer token
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          request.log.warn({ requestId: request.id }, "admin replay: missing or invalid authorization header");
          return reply.status(401).send({
            code: "REQUEST_ERROR",
            error: "missing or invalid authorization header",
            requestId: request.id,
          });
        }

        const token = authHeader.slice(7); // Remove "Bearer " prefix
        if (token !== config.adminToken) {
          request.log.warn({ requestId: request.id }, "admin replay: invalid token");
          return reply.status(401).send({
            code: "REQUEST_ERROR",
            error: "invalid admin token",
            requestId: request.id,
          });
        }

        // Check if a replay is already in progress
        if (replayInProgress) {
          request.log.warn({ requestId: request.id }, "admin replay: already in progress");
          return reply.status(409).send({
            code: "REQUEST_ERROR",
            error: "replay already in progress",
            requestId: request.id,
          });
        }

        const body = request.body ?? {};
        const limit = typeof body.limit === "number" && body.limit >= 1 && body.limit <= 1000
          ? Math.floor(body.limit)
          : 20;
        const dryRun = body.dryRun === true;

        replayInProgress = true;
        request.log.info(
          { requestId: request.id, limit, dryRun },
          "admin replay: starting failed event replay",
        );

        try {
          const summary = await replayFailedEvents(
            server,
            config.contractId,
            config.networkPassphrase,
            { limit, dryRun },
          );

          request.log.info(
            {
              requestId: request.id,
              attempted: summary.attempted,
              succeeded: summary.succeeded,
              failed: summary.failed,
              dryRun: summary.dryRun,
            },
            "admin replay: finished",
          );

          return reply.status(200).send(summary);
        } finally {
          replayInProgress = false;
        }
      },
    );
  };
}
