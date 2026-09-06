import pino from "pino";

// Shared logger for the entire process. Both Fastify (HTTP server) and the
// indexer import this single instance so all structured output lands in one
// stream. Individual components attach context via `logger.child({ module: "…" })`.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export type Logger = typeof logger;
