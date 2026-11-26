import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as indexerStateRepo from "../src/repositories/indexer-state.js";
import { streamRoutes } from "../src/routes/streams.js";
import { buildServer } from "../src/server.js";

describe("Indexer lag header exclusions and error handling (#674)", () => {
  let getPositionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getPositionSpy = vi.spyOn(indexerStateRepo, "getIndexerPosition").mockResolvedValue({
      lastLedger: 100,
      chainLedger: 150,
      cursor: "cursor-123",
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds X-Indexer-Lag-Ledgers to successful GET read endpoints", async () => {
    const app = await buildServer();
    app.get("/", async (_req, reply) => reply.send({ ok: true }));
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBe("50");
    await app.close();
  });

  it("skips header for exact exclusions (/health, /ready, /metrics)", async () => {
    const app = await buildServer();

    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.headers["x-indexer-lag-ledgers"]).toBeUndefined();

    const readyRes = await app.inject({ method: "GET", url: "/ready" });
    expect(readyRes.headers["x-indexer-lag-ledgers"]).toBeUndefined();

    const metricsRes = await app.inject({ method: "GET", url: "/metrics" });
    expect(metricsRes.headers["x-indexer-lag-ledgers"]).toBeUndefined();

    await app.close();
  });

  it("skips header when query strings are present on excluded routes", async () => {
    const app = await buildServer();

    const healthWithQuery = await app.inject({ method: "GET", url: "/health?verbose=true" });
    expect(healthWithQuery.headers["x-indexer-lag-ledgers"]).toBeUndefined();

    const readyWithQuery = await app.inject({ method: "GET", url: "/ready?probe=1" });
    expect(readyWithQuery.headers["x-indexer-lag-ledgers"]).toBeUndefined();

    const metricsWithQuery = await app.inject({ method: "GET", url: "/metrics?format=prometheus" });
    expect(metricsWithQuery.headers["x-indexer-lag-ledgers"]).toBeUndefined();

    await app.close();
  });

  it("does not exclude routes that merely share a prefix with excluded routes", async () => {
    const app = await buildServer();

    app.get("/healthcheck", async (_req, reply) => {
      return reply.send({ ok: true });
    });
    app.get("/readiness", async (_req, reply) => {
      return reply.send({ ok: true });
    });

    const healthcheckRes = await app.inject({ method: "GET", url: "/healthcheck" });
    expect(healthcheckRes.statusCode).toBe(200);
    expect(healthcheckRes.headers["x-indexer-lag-ledgers"]).toBe("50");

    const readinessRes = await app.inject({ method: "GET", url: "/readiness" });
    expect(readinessRes.statusCode).toBe(200);
    expect(readinessRes.headers["x-indexer-lag-ledgers"]).toBe("50");

    await app.close();
  });

  it("skips header and avoids database read on 404 responses", async () => {
    const app = await buildServer();
    getPositionSpy.mockClear();

    const response = await app.inject({ method: "GET", url: "/non-existent-route" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(getPositionSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("skips header and avoids database read on 400 validation error responses", async () => {
    const app = await buildServer();
    await app.register(streamRoutes);
    getPositionSpy.mockClear();

    const response = await app.inject({ method: "GET", url: "/streams/invalid-id" });

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(getPositionSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("skips header and avoids database read on 304 Not Modified responses", async () => {
    const app = await buildServer();

    app.get("/cached-route", async (_req, reply) => {
      return reply.status(304).send();
    });

    getPositionSpy.mockClear();
    const response = await app.inject({ method: "GET", url: "/cached-route" });

    expect(response.statusCode).toBe(304);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(getPositionSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("skips header on non-GET requests", async () => {
    const app = await buildServer();

    app.post("/submit", async (_req, reply) => {
      return reply.send({ ok: true });
    });

    getPositionSpy.mockClear();
    const response = await app.inject({ method: "POST", url: "/submit" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-indexer-lag-ledgers"]).toBeUndefined();
    expect(getPositionSpy).not.toHaveBeenCalled();

    await app.close();
  });
});
