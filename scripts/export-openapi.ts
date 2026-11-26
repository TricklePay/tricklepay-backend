import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { metricsRoutes } from "../src/routes/metrics.js";
import { rootRoutes } from "../src/routes/root.js";
import { statusRoutes } from "../src/routes/status.js";
import { streamRoutes } from "../src/routes/streams.js";
import { buildServer } from "../src/server.js";

/**
 * Exports the OpenAPI 3.0 JSON specification for the service.
 * Used in CI to detect breaking changes between branches (#778).
 */
export async function exportOpenApiSpec(outputPath: string): Promise<void> {
  const targetPath = resolve(outputPath);
  const app = await buildServer({ enableDocsUi: false });
  await app.register(
    rootRoutes({
      network: "testnet",
      contractId: "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW",
    } as never),
  );
  await app.register(streamRoutes);
  await app.register(statusRoutes);
  await app.register(metricsRoutes, { token: undefined });
  await app.ready();

  const spec = app.swagger();
  await app.close();

  writeFileSync(targetPath, JSON.stringify(spec, null, 2) + "\n", "utf-8");
  console.log(`OpenAPI document exported successfully to ${targetPath}`);
}

// When executed directly as CLI script
if (process.argv[1]?.endsWith("export-openapi.ts") || process.argv[1]?.endsWith("export-openapi.js")) {
  const output = process.argv[2] || "openapi.json";
  exportOpenApiSpec(output).catch((err) => {
    console.error("Failed to export OpenAPI document:", err);
    process.exit(1);
  });
}
