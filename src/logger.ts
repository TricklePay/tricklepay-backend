import pino from "pino";

// One logger shared by the HTTP server and the indexer so all output lands in
// a single structured stream. Components attach their own context with
// `logger.child({ module: "indexer" })`.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export type Logger = typeof logger;
