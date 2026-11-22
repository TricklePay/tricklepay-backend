// Tests that probe and metrics routes never carry the lag header or cache-control
// headers that belong on data routes only. The exclusion rules must not regress.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  checkHealth: vi.fn(),
}));

const indexerState = vi.hoisted(() => ({
  getIndexerPosition: vi.fn(),
  hasIndexerProgress: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ checkHealth: db.checkHealth }));
vi.mock("../../src/repositories/indexer-state.js", () => ({
  getIndexerPosition: indexerState.getIndexerPosition,
  hasIndexerProgress: indexerState.hasIndexerProgress,
}));

const { buildServer } = await import("../../src/server.js");

describe("probe routes never get lag or cache headers (#722)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.checkHealth.mockResolvedValue({ status: "up" });
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 50,
      chainLedger: 100,
      cursor: "cursor",
      updatedAt: new Date(),
    });
    indexerState.hasIndexerProgress.mockReturnValue(true);
  });

  it("omits X-Indexer-Lag-Ledgers and Cache-Control from /health", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(response.headers["cache-control"]).not.toMatch(/public/);
    expect(response.headers["cache-control"]).not.toMatch(/max-age/);
  });

  it("omits X-Indexer-Lag-Ledgers and Cache-Control from /health with query string", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health?debug=1" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(response.headers["cache-control"]).not.toMatch(/public/);
    expect(response.headers["cache-control"]).not.toMatch(/max-age/);
  });

  it("omits X-Indexer-Lag-Ledgers and Cache-Control from /ready", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(response.headers["cache-control"]).not.toMatch(/public/);
    expect(response.headers["cache-control"]).not.toMatch(/max-age/);
  });

  it("omits X-Indexer-Lag-Ledgers and Cache-Control from /ready with query string", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/ready?verbose=true" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(response.headers["cache-control"]).not.toMatch(/public/);
    expect(response.headers["cache-control"]).not.toMatch(/max-age/);
  });

  it("omits X-Indexer-Lag-Ledgers and Cache-Control from /metrics", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(response.headers["cache-control"]).not.toMatch(/public/);
    expect(response.headers["cache-control"]).not.toMatch(/max-age/);
  });

  it("omits X-Indexer-Lag-Ledgers and Cache-Control from /metrics with query string", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/metrics?format=text" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(response.headers["cache-control"]).not.toMatch(/public/);
    expect(response.headers["cache-control"]).not.toMatch(/max-age/);
  });

  it("includes X-Indexer-Lag-Ledgers and Cache-Control on data route /status", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/status" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeDefined();
    expect(response.headers["cache-control"]).toBeDefined();
  });
});
