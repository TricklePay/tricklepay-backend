import { createRpcServer } from "./chain/rpc.js";
import { loadConfig } from "./config.js";
import { disconnect } from "./db.js";
import { Poller } from "./indexer/poller.js";
import { logger } from "./logger.js";
import { rootRoutes } from "./routes/root.js";
import { statusRoutes } from "./routes/status.js";
import { streamRoutes } from "./routes/streams.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const app = await buildServer();
  await app.register(rootRoutes);
  await app.register(streamRoutes);
  await app.register(statusRoutes);

  const poller = new Poller(createRpcServer(config), config, logger);
  // The indexer runs in the background alongside the HTTP server. A failure
  // here is logged rather than left to crash the process serving the API.
  poller.start().catch((err) => logger.error({ err }, "indexer stopped"));

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
