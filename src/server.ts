import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";

import swagger from "@fastify/swagger";

import swaggerUi from "@fastify/swagger-ui";

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import { swaggerConfig, swaggerUiConfig } from "./api-spec.js";

import {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  type Config,
} from "./config.js";

import { registerErrorHandlers } from "./error-handlers.js";

import { registerHealthRoutes } from "./health-routes.js";

import { logger } from "./logger.js";

import { registerMetricsPlugin } from "./metrics-plugin.js";

import { isTrustedProxyAddress } from "./proxy.js";

import { parseQueryString } from "./query-string-parser.js";

import { REQUEST_ID_HEADER, sanitizeRequestId } from "./request-id.js";

import { registerRequestIdHook } from "./request-id-hook.js";

import { registerSharedSchemas } from "./schemas.js";

// Request-id sanitisation lives in `./request-id.ts`, the echo hook in
// `./request-id-hook.ts`, error redaction in `./error-redaction.ts`, error
// handlers in `./error-handlers.ts`, shared schemas in `./schemas.ts`, and
// health routes in `./health-routes.ts` — all independently testable.

// Builds the Fastify instance with the shared logger, CORS, the OpenAPI
// plugin, and the routes that do not depend on external services. Route groups
// that need the database are registered by the caller during bootstrap.
//
// @fastify/swagger MUST be registered before any routes so that it can observe
// every route schema. The shared JSON Schema definitions ($id-bearing objects)
// are added to the Fastify schema store here so that routes may reference them
// with $ref and the plugin emits them as reusable OpenAPI components.
export async function buildServer(config?: Partial<Config>): Promise<FastifyInstance> {
  const trustedProxies = config?.trustedProxies ?? [];
  const rateLimitMax = config?.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  const rateLimitWindowMs = config?.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const app = Fastify({
    // Fastify types its logger as FastifyBaseLogger; the pino instance
    // satisfies that interface at runtime.
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: config?.bodyLimit,
    // Forwarded headers (X-Forwarded-For, X-Forwarded-Proto) are honored only
    // when the direct connection peer is an explicitly trusted proxy (#75).
    // Without configuration the socket address is used as-is, so a direct
    // client cannot spoof the recorded client address in logs or request
    // metadata.
    trustProxy:
      trustedProxies.length > 0
        ? (address: string) => isTrustedProxyAddress(address, trustedProxies)
        : false,
    // Derive the request id from a client-supplied header when it is safe,
    // otherwise generate one. Fastify binds the id to the per-request child
    // logger, so it lands in every structured request log line as `reqId`.
    genReqId: (req) =>
      sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID(),
    querystringParser: parseQueryString,
  });

  // Enforce the query string length limit before routing.
  app.addHook("onRequest", async (request, reply) => {
    const rawQuery = request.raw.url?.split("?")[1] ?? "";
    if (config?.queryStringLimit && rawQuery.length > config.queryStringLimit) {
      void reply.status(400).send({
        code: "VALIDATION_ERROR",
        error: "query string too long",
        requestId: request.id,
      });
      return reply;
    }
  });

  // Echo the request id header on every response.
  registerRequestIdHook(app);

  // Record every response against the Prometheus counters and histograms.
  await registerMetricsPlugin(app);

  // Attach structured error codes, redacted messages, and request ids to
  // every error response.
  registerErrorHandlers(app);

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
  registerSharedSchemas(app);

  // Generate the OpenAPI 3.0 spec from route schemas automatically.
  await app.register(swagger, swaggerConfig);

  // Serve the interactive Swagger UI at /docs and the raw spec at /docs/json
  // and /docs/yaml (these paths are the @fastify/swagger-ui defaults).
  await app.register(swaggerUi, swaggerUiConfig);

  // Liveness and readiness probes.
  registerHealthRoutes(app);

  return app;
}
