import { createRpcServer } from "./chain/rpc.js";

import { loadConfig } from "./config.js";

import { disconnect } from "./db.js";

import { Poller } from "./indexer/poller.js";

import { logger } from "./logger.js";

import { metricsRoutes } from "./routes/metrics.js";

import { rootRoutes } from "./routes/root.js";

import { statusRoutes } from "./routes/status.js";

import { streamRoutes } from "./routes/streams.js";

import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const app = await buildServer(config);
  await app.register(rootRoutes(config));
  await app.register(streamRoutes);
  await app.register(statusRoutes);
  await app.register(metricsRoutes);

  const poller = new Poller(createRpcServer(config), config, logger);
  // The indexer runs in the background alongside the HTTP server. A failure
  // here is logged rather than left to crash the process serving the API.
  poller.start().catch((err) => logger.error({ err }, "indexer stopped"));

  // Graceful shutdown order matters:
  //
  // 1. Stop the poller first so it doesn't start new poll ticks or initiate
  //    fresh database writes. stop() is synchronous — it sets a flag and the
  //    current page/transaction finishes, but no new tick begins.
  //
  // 2. Close the HTTP server next. Fastify stops accepting new connections and
  //    waits for all in-flight request handlers to complete. Those handlers may
  //    still query the database, so we keep the connection pool open.
  //
  // 3. Disconnect the database last, only after the HTTP server has fully
  //    drained. This ensures in-flight requests can finish their queries
  //    without hitting a closed connection.
  //
  // If this order were reversed (e.g. DB closed before the HTTP server),
  // in-flight requests would fail with connection errors.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    poller.stop();
    await app.close();
    await disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    logger.error({ err }, "failed to start server");
    process.exit(1);
  }
}

void main();
