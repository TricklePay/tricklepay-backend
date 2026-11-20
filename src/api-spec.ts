import type { FastifyDynamicSwaggerOptions } from "@fastify/swagger";
import type { FastifySwaggerUiOptions } from "@fastify/swagger-ui";

// OpenAPI specification configuration for the TricklePay API.
// This module contains all the metadata, tags, and component configuration
// that @fastify/swagger uses to generate the OpenAPI document.
//
// `serverUrl` is the base URL generated clients should default to. It comes
// from configuration (see `publicBaseUrl` in config.ts) so the document
// points at the deployment that served it rather than a hard-coded host.
export function buildSwaggerConfig(serverUrl: string): FastifyDynamicSwaggerOptions {
  return {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "TricklePay API",
        description:
          "Indexer and read API for TricklePay token streams on Stellar. " +
          "The indexer mirrors on-chain stream state into Postgres and this API " +
          "serves it, computing live vesting figures server-side.",
        version: "0.1.0",
        contact: {
          name: "TricklePay",
          url: "https://github.com/TricklePay/tricklepay-backend",
        },
        license: {
          name: "MIT",
          url: "https://opensource.org/licenses/MIT",
        },
      },
      servers: [{ url: serverUrl, description: "This deployment" }],
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
        // Schemas are pulled from app.addSchema calls; no need to list
        // them here — @fastify/swagger discovers them automatically.
      },
    },
    // Without this, every shared schema is emitted under a positional name
    // ("def-0", "def-1", ...) and the $ref targets in the routes point at
    // those. Naming each component after its $id is what makes the spec
    // readable and keeps generated clients stable as schemas are added.
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return (json.$id as string | undefined) ?? `def-${i}`;
      },
    },
  };
}

// Swagger UI configuration for the interactive documentation interface.
export const swaggerUiConfig: FastifySwaggerUiOptions = {
  routePrefix: "/docs",
  uiConfig: {
    // Open the models panel by default so the schema components are visible.
    defaultModelsExpandDepth: 2,
    defaultModelExpandDepth: 3,
  },
};
