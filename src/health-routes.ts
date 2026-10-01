// ---------------------------------------------------------------------------
// Health routes (#240).
//
// /health — liveness: returns 200 as long as the process is up.
// /ready  — readiness: checks database connectivity and indexer lag.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";

import { checkHealth } from "./db.js";

import { getIndexerPosition } from "./repositories/indexer-state.js";

import { serviceVersion } from "./version.js";

/**
 * Registers the `/health` (liveness) and `/ready` (readiness) routes on
 * `app`. These routes do not depend on any route-level plugin and can be
 * registered before or after the OpenAPI plugins.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(
    "/health",
    {
      schema: {
        summary: "Liveness check",
        description:
          "Returns 200 when the server is up, along with the running service version. No database read is performed.",
        tags: ["indexer"],
        response: {
          200: {
            type: "object",
            required: ["status", "version"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              version: {
                type: "string",
                description:
                  "Service version from the package manifest, for distinguishing binaries during rolling releases.",
              },
            },
          },
        },
      },
    },
    async () => {
      return { status: "ok", version: serviceVersion };
    },
  );

  app.get(
    "/ready",
    {
      schema: {
        summary: "Readiness check",
        description:
          "Verifies database connectivity and reports indexer lag. Returns 503 when a dependency is unavailable.",
        tags: ["indexer"],
        response: {
          200: {
            type: "object",
            required: ["status", "database", "indexer"],
            properties: {
              status: { type: "string", enum: ["ready"] },
              database: { type: "string", enum: ["up"] },
              indexer: {
                type: "object",
                required: ["lagLedgers"],
                properties: {
                  lagLedgers: { type: ["integer", "null"] },
                },
              },
            },
          },
          503: {
            type: "object",
            required: ["status", "database"],
            properties: {
              status: { type: "string", enum: ["not_ready"] },
              database: { type: "string", enum: ["down"] },
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const db = await checkHealth();
      if (db.status === "down") {
        void reply.status(503);
        return { status: "not_ready", database: "down", error: db.error };
      }

      const position = await getIndexerPosition();
      const lagLedgers = position
        ? Math.max(0, position.chainLedger - position.lastLedger)
        : null;

      return { status: "ready", database: "up", indexer: { lagLedgers } };
    },
  );
}
