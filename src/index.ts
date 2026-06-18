import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    logger.error(err, "failed to start server");
    process.exit(1);
  }
}

void main();
