import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";

import compress from "@fastify/compress";

import swagger from "@fastify/swagger";

import swaggerUi from "@fastify/swagger-ui";

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import { buildSwaggerConfig, swaggerUiConfig } from "./api-spec.js";

import {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_READINESS_RETRY_AFTER_SECONDS,
  DEFAULT_COMPRESSION_THRESHOLD_BYTES,
  defaultPublicBaseUrl,
  type Config,
} from "./config.js";

import { errorCodeForStatus } from "./error-redaction.js";

import { registerErrorHandlers } from "./error-handlers.js";

import { registerHealthRoutes } from "./health-routes.js";

import { logger } from "./logger.js";

import { registerMetricsPlugin } from "./metrics-plugin.js";

import { isTrustedProxyAddress } from "./proxy.js";

import { parseQueryString } from "./query-string-parser.js";

import { REQUEST_ID_HEADER, sanitizeRequestId } from "./request-id.js";

import { registerRequestIdHook } from "./request-id-hook.js";

import { registerSharedSchemas } from "./schema-registration.js";

import { registerSecurityHeaders } from "./security-headers.js";

// Request-id sanitisation lives in `./request-id.ts`, the echo hook in
// `./request-id-hook.ts`, error redaction in `./error-redaction.ts`, error
// handlers in `./error-handlers.ts`, shared schemas in `./schema-registration.ts`, and
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
  const readinessRetryAfterSeconds =
    config?.readinessRetryAfterSeconds ?? DEFAULT_READINESS_RETRY_AFTER_SECONDS;
  const publicBaseUrl =
    config?.publicBaseUrl ??
    defaultPublicBaseUrl(config?.host ?? "0.0.0.0", config?.port ?? 3000);
  const compressionThresholdBytes =
    config?.compressionThresholdBytes ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES;
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
    // Fastify's default Ajv strips properties a schema forbids with
    // `additionalProperties: false`. Turn that off so an unknown or misspelt
    // query parameter (`limt=5`) is rejected with a 400 instead of silently
    // changing paging results.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Query-string hardening (#519). Fastify parses the query string while
  // routing, before any hook, so this runs after parsing but still before the
  // route handler and before any database access.
  //
  // Repeating a parameter is rejected instead of silently keeping the last
  // value, which would hide client mistakes and is a known parameter-pollution
  // footgun. The parser itself must never throw: it runs during routing, where
  // an exception bypasses Fastify's error handler and crashes the process.
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

    const seen = new Set<string>();
    for (const key of new URLSearchParams(rawQuery).keys()) {
      if (seen.has(key)) {
        void reply.status(400).send({
          code: errorCodeForStatus(400),
          error: `repeated query parameter: ${key}`,
          requestId: request.id,
        });
        return reply;
      }
      seen.add(key);
    }
  });

  const clientWindows = new Map<string, { requests: number; resetAt: number }>();
  const maxTrackedClients = 10_000;

  app.addHook("onRequest", async (request, reply) => {
    const now = Date.now();
    let window = clientWindows.get(request.ip);

    if (!window || window.resetAt <= now) {
      if (window) {
        clientWindows.delete(request.ip);
      } else if (clientWindows.size >= maxTrackedClients) {
        for (const [ip, trackedWindow] of clientWindows) {
          if (trackedWindow.resetAt <= now) clientWindows.delete(ip);
        }
        if (clientWindows.size >= maxTrackedClients) {
          const oldestIp = clientWindows.keys().next().value;
          if (oldestIp !== undefined) clientWindows.delete(oldestIp);
        }
      }
      window = { requests: 0, resetAt: now + rateLimitWindowMs };
    }

    clientWindows.delete(request.ip);
    clientWindows.set(request.ip, window);

    if (window.requests >= rateLimitMax) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      return reply
        .header("Retry-After", String(retryAfter))
        .status(429)
        .send({
          code: errorCodeForStatus(429),
          error: "rate limit exceeded",
          requestId: request.id,
        });
    }

    window.requests += 1;
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

  // Compress responses at or above the configured threshold when the client
  // advertises gzip or brotli support. Large list responses are repetitive
  // JSON, so this cuts transfer size; smaller responses and clients that do
  // not opt in are served uncompressed. Registered before the routes so the
  // onSend hook applies to every response.
  void app.register(compress, {
    global: true,
    threshold: compressionThresholdBytes,
  });

  // Hardening headers on every response, including the docs and error handlers
  // (#520). Registered before the routes so no route can miss them.
  await registerSecurityHeaders(app);

  // Register shared schemas so routes can reference them with { $ref: "$id" }.
  // @fastify/swagger will emit them as named components in the spec.
  registerSharedSchemas(app);

  // Generate the OpenAPI 3.0 spec from route schemas automatically.
  await app.register(swagger, buildSwaggerConfig(publicBaseUrl));

  // Serve the interactive Swagger UI at /docs and the raw spec at /docs/json
  // and /docs/yaml (these paths are the @fastify/swagger-ui defaults).
  //
  // ENABLE_DOCS_UI=false (#521) removes the UI plugin entirely — the HTML page
  // and its static assets — while the machine-readable document stays at the
  // same paths, generated on demand from the route schemas. `hide: true` keeps
  // the two helper routes out of the document itself.
  if (config?.enableDocsUi ?? true) {
    await app.register(swaggerUi, swaggerUiConfig);
  } else {
    app.get("/docs/json", { schema: { hide: true } }, async (_request, reply) => {
      return reply
        .type("application/json; charset=utf-8")
        .send(app.swagger());
    });

    app.get("/docs/yaml", { schema: { hide: true } }, async (_request, reply) => {
      return reply
        .type("application/yaml; charset=utf-8")
        .send(app.swagger({ yaml: true }));
    });
  }

  // Liveness and readiness probes.
  registerHealthRoutes(app, readinessRetryAfterSeconds);

  return app;
}
