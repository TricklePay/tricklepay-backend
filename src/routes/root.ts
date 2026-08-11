import type { FastifyInstance } from "fastify";

// A self-describing index of the API, so a caller hitting the root learns what
// endpoints exist without reading the source.
export async function rootRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", {
    schema: {
      summary: "API index",
      description: "Self-describing index of all available endpoints.",
      tags: ["meta"],
      // Keep the root route out of the OpenAPI spec to avoid a circular
      // reference: the spec documents itself via /docs/json.
      hide: true,
    },
  }, async () => {
    return {
      name: "tricklepay-backend",
      description: "Indexer and read API for TricklePay token streams",
      endpoints: [
        { method: "GET", path: "/health", description: "Liveness check" },
        { method: "GET", path: "/status", description: "Indexer progress" },
        { method: "GET", path: "/docs/json", description: "OpenAPI spec (JSON)" },
        { method: "GET", path: "/docs/yaml", description: "OpenAPI spec (YAML)" },
        { method: "GET", path: "/docs", description: "Swagger UI" },
        {
          method: "GET",
          path: "/streams",
          description: "List streams; filters: sender, recipient, token, limit, offset",
        },
        { method: "GET", path: "/streams/:id", description: "A single stream by id" },
      ],
    };
  });
}
