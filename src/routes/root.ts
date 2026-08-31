// Registers the GET / endpoint.
// This route returns a static API index and does not read from the database.

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

// A self-describing index of the API, so a caller hitting the root learns what
// endpoints exist without reading the source.
export function rootRoutes(config: Config) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get("/", async () => {
      return {
        name: "tricklepay-backend",
        description: "Indexer and read API for TricklePay token streams",
        network: config.network,
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
