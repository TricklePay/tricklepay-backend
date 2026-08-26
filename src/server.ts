import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { logger } from "./logger.js";
import { httpRequestDuration, httpRequestsTotal } from "./metrics.js";
import {
  apiErrorSchema,
  indexerStatusSchema,
  streamListResponseSchema,
  streamSummaryResponseSchema,
  streamViewSchema,
} from "./schema.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Request ids.
//
// Every request gets an id that appears as the `reqId` field in Fastify's
// structured request logs and is echoed back in the `x-request-id` response
// header and error bodies, so a client report can be matched to its log lines.
// A caller may supply its own id through `x-request-id`, but arbitrary header
// values are not trusted: an id is forwarded only when it is short and made of
// safe characters; anything else (or nothing) yields a fresh UUID.
// ---------------------------------------------------------------------------
export const REQUEST_ID_HEADER = "x-request-id";

const MAX_REQUEST_ID_LENGTH = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_REQUEST_ID_LENGTH) return undefined;
  return REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

// Builds the Fastify instance with the shared logger, CORS, the OpenAPI
// plugin, and the routes that do not depend on external services. Route groups
// that need the database are registered by the caller during bootstrap.
//
// @fastify/swagger MUST be registered before any routes so that it can observe
// every route schema. The shared JSON Schema definitions ($id-bearing objects)
// are added to the Fastify schema store here so that routes may reference them
// with $ref and the plugin emits them as reusable OpenAPI components.
export async function buildServer(config?: Config): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify types its logger as FastifyBaseLogger; the pino instance
    // satisfies that interface at runtime.
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: config?.bodyLimit,
    // Derive the request id from a client-supplied header when it is safe,
    // otherwise generate one. Fastify binds the id to the per-request child
    // logger, so it lands in every structured request log line as `reqId`.
    genReqId: (req) =>
      sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID(),
    querystringParser: (str: string) => {
      if (config?.queryStringLimit && str.length > config.queryStringLimit) {
        throw new Error("query string too long");
      }
      const params = new URLSearchParams(str);
      const result: Record<string, string> = {};
      params.forEach((value, key) => {
        result[key] = value;
      });
      return result;
    },
  });

  // Record every response against the Prometheus counters. `routeOptions.url`
  // is the route pattern ("/streams/:id") rather than the resolved path, which
  // keeps the label set bounded no matter how many distinct ids are requested.
  // Unmatched requests fall back to "unknown" for the same reason.
  app.addHook("onResponse", async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions?.url ?? "unknown",
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime);
  });

  // Echo the request id on every response so clients can quote it back. Set
  // before routing, so even requests that fail early carry the header.
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Attach the request id to error bodies so an error a client saw can be
  // traced to its log lines. Status codes are preserved; unexpected failures
  // (no statusCode, i.e. 500s) report a generic message rather than leaking
  // internals.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const statusCode = typeof err.statusCode === "number" && err.statusCode >= 400
      ? err.statusCode
      : 500;
    void reply.status(statusCode).send({
      error: statusCode >= 500 ? "internal server error" : err.message,
      requestId: request.id,
    });
  });

  // Unmatched routes bypass the error handler, so they get their own handler —
  // with the request id attached like every other error response.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });

  // The web client fetches this API from the browser, so it is always a
  // cross-origin caller once the two run on separate ports or hosts. The data
  // served here is public and read-only, so any origin is reflected by
  // default; set CORS_ORIGIN to pin deployments to a known frontend. Not
  // awaited because Fastify defers plugin loading until ready/listen, which
  // keeps this builder synchronous for its callers.
  void app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? true,
  });

  // Register shared schemas so routes can reference them with { $ref: "$id" }.
  // @fastify/swagger will emit them as named components in the spec.
  app.addSchema(streamViewSchema);
  app.addSchema(streamListResponseSchema);
  app.addSchema(streamSummaryResponseSchema);
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
    // Without this, every shared schema is emitted under a positional name
    // ("def-0", "def-1", ...) and the $ref targets in the routes point at
    // those. Naming each component after its $id is what makes the spec
    // readable and keeps generated clients stable as schemas are added.
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return (json.$id as string | undefined) ?? `def-${i}`;
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
