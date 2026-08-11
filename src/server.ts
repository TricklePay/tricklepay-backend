import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { logger } from "./logger.js";
import {
  apiErrorSchema,
  indexerStatusSchema,
  streamListResponseSchema,
  streamViewSchema,
} from "./schema.js";

// Builds the Fastify instance with the shared logger, the OpenAPI plugin, and
// the routes that do not depend on external services. Route groups that need
// the database are registered by the caller during bootstrap.
//
// @fastify/swagger MUST be registered before any routes so that it can observe
// every route schema. The shared JSON Schema definitions ($id-bearing objects)
// are added to the Fastify schema store here so that routes may reference them
// with $ref and the plugin emits them as reusable OpenAPI components.
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify types its logger as FastifyBaseLogger; the pino instance
    // satisfies that interface at runtime.
    loggerInstance: logger as FastifyBaseLogger,
  });

  // Register shared schemas so routes can reference them with { $ref: "$id" }.
  // @fastify/swagger will emit them as named components in the spec.
  app.addSchema(streamViewSchema);
  app.addSchema(streamListResponseSchema);
  app.addSchema(indexerStatusSchema);
  app.addSchema(apiErrorSchema);

  // Generate the OpenAPI 3.0 spec from route schemas automatically.
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "TricklePay API",
        description:
          "Indexer and read API for TricklePay token streams on Stellar. " +
          "The indexer mirrors on-chain stream state into Postgres and this API " +
          "serves it, computing live vesting figures server-side.",
        version: "0.1.0",
        license: {
          name: "MIT",
          url: "https://opensource.org/licenses/MIT",
        },
      },
      tags: [
        {
          name: "streams",
          description: "Token stream read endpoints.",
        },
        {
          name: "indexer",
          description: "Indexer health and progress.",
        },
      ],
      components: {
        // Schemas are pulled from app.addSchema calls above; no need to list
        // them here — @fastify/swagger discovers them automatically.
      },
    },
  });

  // Serve the interactive Swagger UI at /docs and the raw spec at /docs/json
  // and /docs/yaml (these paths are the @fastify/swagger-ui defaults).
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      // Open the models panel by default so the schema components are visible.
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 3,
    },
  });

  app.get("/health", {
    schema: {
      summary: "Liveness check",
      description: "Returns 200 when the server is up. No database read is performed.",
      tags: ["indexer"],
      response: {
        200: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["ok"] },
          },
        },
      },
    },
  }, async () => {
    return { status: "ok" };
  });

  return app;
}
