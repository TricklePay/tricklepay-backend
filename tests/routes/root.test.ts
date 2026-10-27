import Fastify from "fastify";

import { describe, expect, it } from "vitest";

import { registerHealthRoutes } from "../../src/health-routes.js";
import { metricsRoutes } from "../../src/routes/metrics.js";
import { statusRoutes } from "../../src/routes/status.js";
import { streamRoutes } from "../../src/routes/streams.js";
import { registerSharedSchemas } from "../../src/schema-registration.js";
import { buildServer } from "../../src/server.js";

// Root endpoint returns the configured Stellar network name so clients
// catch testnet/mainnet wiring mistakes without reading private configuration.

const { rootRoutes } = await import("../../src/routes/root.js");

const mockConfig = {
  network: "testnet",
  port: 3000,
  host: "0.0.0.0",
  publicBaseUrl: "http://localhost:3000",
  databaseUrl: "postgres://test",
  networkPassphrase: "Test DF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CA123",
  pollIntervalMs: 5000,
  startLedger: 0,
  maxBackoffMs: 60000,
  maxPagesPerTick: 1000,
  bodyLimit: 1048576,
  queryStringLimit: 2048,
  compressionThresholdBytes: 1024,
  trustedProxies: [],
  rateLimitAllowlist: [],
  summaryCacheTtlMs: 2000,
  readinessRetryAfterSeconds: 5,
  readyMaxStalenessMs: 0,
  enableDocsUi: true,
};

async function getRoot() {
  const app = Fastify();
  await app.register(rootRoutes(mockConfig));
  const response = await app.inject({ method: "GET", url: "/" });
  await app.close();
  return { statusCode: response.statusCode, body: response.json() };
}

describe("GET /", () => {
  it("returns 200 with application/json content type", async () => {
    const app = Fastify();
    await app.register(rootRoutes(mockConfig));
    const response = await app.inject({ method: "GET", url: "/" });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("includes the network name in the response", async () => {
    const { statusCode, body } = await getRoot();
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty("network");
    expect(typeof body.network).toBe("string");
    expect(["testnet", "mainnet"]).toContain(body.network);
  });

  it("still returns the standard API index fields", async () => {
    const { body } = await getRoot();
    expect(body).toHaveProperty("name", "tricklepay-backend");
    expect(body).toHaveProperty("description");
    expect(body).toHaveProperty("endpoints");
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it("includes the indexed contract id", async () => {
    const { body } = await getRoot();
    expect(body.contractId).toBe(mockConfig.contractId);
  });

  it("lists every registered route across all server plugins (excluding / and /docs*)", async () => {
    const app = Fastify();
    registerSharedSchemas(app);
    const registeredRoutes = new Set<string>();
    const skippedDocRoutes = new Set<string>();

    app.addHook("onRoute", (routeOptions) => {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
      const path = routeOptions.url;

      // Explicitly handle documentation-only routes (/docs, /docs/json, /docs/yaml, static assets)
      // and the root index endpoint itself (GET /).
      if (path === "/docs" || path.startsWith("/docs/")) {
        for (const method of methods) {
          if (method !== "HEAD" && method !== "OPTIONS") {
            skippedDocRoutes.add(`${method} ${path}`);
          }
        }
        return;
      }
      if (path === "/") {
        return;
      }

      for (const method of methods) {
        // Fastify auto-registers HEAD siblings for GET routes; the index documents
        // primary HTTP methods.
        if (method === "HEAD" || method === "OPTIONS") continue;
        registeredRoutes.add(`${method} ${path}`);
      }
    });

    // Register every route group used by buildServer() and src/index.ts after attaching onRoute.
    registerHealthRoutes(
      app,
      mockConfig.readinessRetryAfterSeconds,
      mockConfig.readyMaxStalenessMs,
    );
    await app.register(rootRoutes(mockConfig));
    await app.register(streamRoutes, { summaryCacheTtlMs: mockConfig.summaryCacheTtlMs });
    await app.register(statusRoutes, { startLedger: mockConfig.startLedger });
    await app.register(metricsRoutes, {});

    // Also build the full server (which registers @fastify/swagger and @fastify/swagger-ui)
    // to verify that /docs* routes are registered and intentionally omitted from GET /.
    const fullServer = await buildServer(mockConfig);
    for (const docPath of ["/docs", "/docs/json", "/docs/yaml"]) {
      if (fullServer.hasRoute({ method: "GET", url: docPath })) {
        skippedDocRoutes.add(`GET ${docPath}`);
      }
    }
    await fullServer.close();

    const response = await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      endpoints: Array<{ method: string; path: string; description: string }>;
    };

    // Documentation routes are present on the server but intentionally omitted from GET /.
    expect(skippedDocRoutes.has("GET /docs/json")).toBe(true);
    expect(skippedDocRoutes.has("GET /docs/yaml")).toBe(true);

    const indexedRoutes = new Set(
      body.endpoints.map((ep) => `${ep.method} ${ep.path}`),
    );
    expect(body.endpoints.length).toBe(indexedRoutes.size);
    for (const ep of body.endpoints) {
      expect(ep.description.trim().length).toBeGreaterThan(0);
    }

    expect([...indexedRoutes].sort()).toEqual([...registeredRoutes].sort());
  });
});
