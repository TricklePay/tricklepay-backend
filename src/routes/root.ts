// Registers the GET / endpoint.
// This route returns a static API index and does not read from the database.

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

import { API_INDEX_SCHEMA_ID, apiIndexSchema } from "../schema.js";

// A self-describing index of the API, so a caller hitting the root learns what
// endpoints exist without reading the source.
export function rootRoutes(config: Config) {
  return async (app: FastifyInstance): Promise<void> => {
    if (!app.getSchema(API_INDEX_SCHEMA_ID)) app.addSchema(apiIndexSchema);
    app.get("/", { schema: { response: { 200: { $ref: API_INDEX_SCHEMA_ID } } } }, async () => {
      return {
        name: "tricklepay-backend",
        description: "Indexer and read API for TricklePay token streams",
        network: config.network,
        contractId: config.contractId,
        endpoints: [
          { method: "GET", path: "/health", description: "Liveness check" },
          { method: "GET", path: "/status", description: "Indexer progress" },
          { method: "GET", path: "/metrics", description: "Prometheus metrics" },
          {
            method: "GET",
            path: "/streams",
            description: "List streams; filters: sender, recipient, token, limit, offset",
          },
          { method: "GET", path: "/streams/:id", description: "A single stream by id" },
        ],
      };
    });
  };
}
