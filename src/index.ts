import { createRpcServer, verifyRpcEndpoint } from "./chain/rpc.js";

import { describeConfig, loadConfig, validateStartLedger } from "./config.js";

import { disconnect } from "./db.js";

import { Poller } from "./indexer/poller.js";

import { logger } from "./logger.js";

import { metricsRoutes } from "./routes/metrics.js";

import { rootRoutes } from "./routes/root.js";

import { statusRoutes } from "./routes/status.js";

import { streamRoutes } from "./routes/streams.js";

import { streamUpdateRoutes } from "./routes/stream-updates.js";

import { buildServer } from "./server.js";

import { createShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // The resolved configuration, before anything that depends on it can fail,
  // so a startup failure is diagnosed against the values that caused it (#474).
  logger.info({ config: describeConfig(config) }, "effective configuration");

  const rpcServer = createRpcServer(config);
  await verifyRpcEndpoint(rpcServer, config.rpcUrl);

  const chainHead = await rpcServer.getLatestLedger();
  validateStartLedger(config.startLedger, chainHead.sequence);

  const app = await buildServer(config);
  
  // Register v1 routes (stable API under /v1 prefix)
  await app.register(
    async (v1Instance) => {
      await v1Instance.register(rootRoutes(config));
      await v1Instance.register(streamRoutes, { summaryCacheTtlMs: config.summaryCacheTtlMs });
      await v1Instance.register(streamUpdateRoutes);
      await v1Instance.register(statusRoutes, { startLedger: config.startLedger, poller: null as any });
      await v1Instance.register(metricsRoutes, { token: config.metricsToken });
    },
    { prefix: "/v1" },
  );

  const poller = new Poller(rpcServer, config, logger);

  // Register unversioned routes (deprecated aliases for backwards compatibility)
  await app.register(rootRoutes(config));
  await app.register(streamRoutes, { summaryCacheTtlMs: config.summaryCacheTtlMs });
  await app.register(streamUpdateRoutes);
  await app.register(statusRoutes, { startLedger: config.startLedger, poller });
  await app.register(metricsRoutes, { token: config.metricsToken });

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
