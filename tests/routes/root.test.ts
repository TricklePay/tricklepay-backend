import Fastify from "fastify";

import { describe, expect, it } from "vitest";

// Root endpoint returns the configured Stellar network name so clients
// catch testnet/mainnet wiring mistakes without reading private configuration.

const { rootRoutes } = await import("../../src/routes/root.js");
const { buildServer } = await import("../../src/server.js");
const { streamRoutes } = await import("../../src/routes/streams.js");
const { streamUpdateRoutes } = await import("../../src/routes/stream-updates.js");
const { statusRoutes } = await import("../../src/routes/status.js");
const { metricsRoutes } = await import("../../src/routes/metrics.js");
const { adminRoutes } = await import("../../src/routes/admin.js");

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
  lagWarnLedgers: 1000,
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

  it("fails when a route is registered on the server but not listed in root endpoints", async () => {
    const { body } = await getRoot();
    const listedEndpoints = new Set(
      body.endpoints.map((e: { method: string; path: string }) => `${e.method} ${e.path}`),
    );

    const registeredRoutes = [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/ready" },
      { method: "GET", path: "/status" },
      { method: "GET", path: "/metrics" },
      { method: "GET", path: "/streams" },
      { method: "GET", path: "/streams/summary" },
      { method: "GET", path: "/streams/:id" },
      { method: "GET", path: "/streams/:id/events" },
      { method: "GET", path: "/streams/:id/schedule" },
      { method: "GET", path: "/accounts/:address/summary" },
      { method: "GET", path: "/tokens" },
      { method: "GET", path: "/docs" },
    ];

    for (const route of registeredRoutes) {
      const key = `${route.method} ${route.path}`;
      expect(listedEndpoints.has(key), `Registered route ${key} is not listed in root index`).toBe(true);
    }
  });

  it("lists all /streams filters including cursor, cancelled, and includeTotal", async () => {
    const { body } = await getRoot();
    const streamsEndpoint = body.endpoints.find((e: { path: string }) => e.path === "/streams");
    expect(streamsEndpoint).toBeDefined();
    for (const param of ["sender", "recipient", "token", "limit", "offset", "cursor", "cancelled", "includeTotal"]) {
      expect(streamsEndpoint.description).toContain(param);
    }
  });

  it("matches every registered production route, excluding documented-only routes explicitly", async () => {
    const app = await buildServer(mockConfig as never);
    await app.register(rootRoutes(mockConfig));
    await app.register(streamRoutes);
    await app.register(streamUpdateRoutes);
    await app.register(statusRoutes, { startLedger: 0, poller: null as never });
    await app.register(metricsRoutes, { token: undefined });
    await app.register(adminRoutes(mockConfig));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/" });
    const index = response.json() as { endpoints: Array<{ method: string; path: string }> };
    const listed = new Set(index.endpoints.map(({ method, path }) => `${method} ${path}`));
    const registered = new Set(
      app.apiRoutes
        .filter((route) => route.method !== "HEAD" && !route.schema?.hide && !route.url.startsWith("/docs"))
        .map((route) => `${route.method} ${route.url}`),
    );

    expect(listed).toEqual(new Set([...registered, "GET /docs"]));
    await app.close();
  });
});
