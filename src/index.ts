import { createRpcServer, verifyRpcEndpoint } from "./chain/rpc.js";

import { loadConfig } from "./config.js";

import { disconnect } from "./db.js";

import { Poller } from "./indexer/poller.js";

import { logger } from "./logger.js";

import { metricsRoutes } from "./routes/metrics.js";

import { rootRoutes } from "./routes/root.js";

import { statusRoutes } from "./routes/status.js";

import { streamRoutes } from "./routes/streams.js";

import { buildServer } from "./server.js";

import { createShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const rpcServer = createRpcServer(config);
  await verifyRpcEndpoint(rpcServer, config.rpcUrl);

  const chainHead = await rpcServer.getLatestLedger();
  if (config.startLedger > chainHead) {
    throw new Error(
      `start ledger ${config.startLedger} is beyond the chain head ${chainHead}; no events will ever be indexed. Set START_LEGGER to a value at or below the current chain head.`,
    );
  }

  const app = await buildServer(config);
  await app.register(rootRoutes(config));
  await app.register(streamRoutes, { summaryCacheTtlMs: config.summaryCacheTtlMs });
  await app.register(statusRoutes, { startLedger: config.startLedger });
  await app.register(metricsRoutes);

  const poller = new Poller(rpcServer, config, logger);
  // Transient errors after the startup check are retried in the background.
  poller.start().catch((err) => logger.error({ err }, "indexer stopped"));

  // Graceful shutdown order (poller -> HTTP server -> database) is documented
  // and unit-tested in ./shutdown.ts.
  const shutdown = createShutdown({ poller, app, disconnect, logger });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    logger.error({ err }, "failed to start server");
    process.exit(1);
  }
}

void main().catch((err) => {
  logger.error({ err }, "failed to start service");
  process.exitCode = 1;
});
