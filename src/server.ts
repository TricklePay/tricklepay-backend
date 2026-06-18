import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { logger } from "./logger.js";

// Builds the Fastify instance with the shared logger and the routes that do
// not depend on external services. Route groups that need the database are
// registered by the caller during bootstrap.
export function buildServer(): FastifyInstance {
  const app = Fastify({
    // Fastify types its logger as FastifyBaseLogger; the pino instance
    // satisfies that interface at runtime.
    loggerInstance: logger as FastifyBaseLogger,
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}
