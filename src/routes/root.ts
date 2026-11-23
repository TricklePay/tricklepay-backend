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
    app.get("/", { schema: { response: { 200: { $ref: API_INDEX_SCHEMA_ID } } } }, async (request) => {
      // Determine if we're on the /v1 prefix by checking the path
      const isV1 = request.routeOptions.url?.startsWith("/v1") ?? false;
      const prefix = isV1 ? "/v1" : "";
      
      return {
        name: "tricklepay-backend",
        description: "Indexer and read API for TricklePay token streams",
        version: isV1 ? "v1" : "unversioned (deprecated)",
        network: config.network,
        contractId: config.contractId,
        endpoints: [
          { method: "GET", path: `${prefix}/`, description: "API index" },
          { method: "GET", path: `${prefix}/health`, description: "Liveness check" },
          { method: "GET", path: `${prefix}/ready`, description: "Readiness check" },
          { method: "GET", path: `${prefix}/status`, description: "Indexer progress" },
          { method: "GET", path: `${prefix}/metrics`, description: "Prometheus metrics" },
          {
            method: "GET",
            path: `${prefix}/streams`,
            description: "List streams; filters: sender, recipient, token, limit, offset, cursor, cancelled, includeTotal, fields",
          },
          { method: "GET", path: `${prefix}/streams/summary`, description: "Summarize streams by status" },
          { method: "GET", path: `${prefix}/streams/:id`, description: "A single stream by id" },
          { method: "GET", path: `${prefix}/streams/:id/events`, description: "Stream event history" },
          { method: "GET", path: `${prefix}/streams/:id/schedule`, description: "Get stream vesting schedule; parameters: points" },
          { method: "GET", path: `${prefix}/accounts/:address/summary`, description: "Get account stream summary" },
          { method: "GET", path: `${prefix}/tokens`, description: "List distinct tokens" },
          { method: "GET", path: "/docs", description: "Interactive OpenAPI documentation" },
        ],
      };
    });
  };
}
