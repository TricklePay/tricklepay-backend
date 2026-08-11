import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { logger } from "./logger.js";
import { httpRequestDuration, httpRequestsTotal } from "./metrics.js";

// Builds the Fastify instance with the shared logger and the routes that do
// not depend on external services. Route groups that need the database are
// registered by the caller during bootstrap.
export function buildServer(): FastifyInstance {
  const app = Fastify({
    // Fastify types its logger as FastifyBaseLogger; the pino instance
    // satisfies that interface at runtime.
    loggerInstance: logger as FastifyBaseLogger,
  });

  // Record latency and request counts for every response. The route label uses
  // Fastify's `routeOptions.url` (the pattern, e.g. `/streams/:id`) rather
  // than the raw URL so high-cardinality paths do not explode the label set.
  app.addHook(
    "onResponse",
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const method = request.method;
      // `routeOptions.url` is the registered pattern; fall back to the raw URL
      // only when Fastify has not matched a route (e.g. 404).
      const route =
        (request.routeOptions as { url?: string } | undefined)?.url ?? request.url;
      const status = String(reply.statusCode);
      const durationMs = reply.elapsedTime;

      httpRequestDuration.observe({ method, route, status }, durationMs);
      httpRequestsTotal.inc({ method, route, status });

      done();
    },
  );

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}
