import { readFile } from "node:fs/promises";

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
const { serviceVersion } = await import("../../src/version.js");

describe("health version field (#76)", () => {
  it("includes a stable version field sourced from the package manifest", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      version: pkg.version,
    });
  });

  it("exposes the same value through the shared version module", () => {
    expect(serviceVersion).toBeTypeOf("string");
    expect(serviceVersion.length).toBeGreaterThan(0);
    expect(serviceVersion).not.toBe("unknown");
  });

  it("stays independent of external dependencies when streams lookups fail", async () => {
    db.checkHealth.mockResolvedValue({ status: "up" });
    indexerState.getIndexerPosition.mockResolvedValue(null);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    expect(response.json().version).toBeTypeOf("string");
  });

  it("returns the unchanged health response while the database is unavailable", async () => {
    db.checkHealth.mockResolvedValue({ status: "down", error: "database unavailable" });
    indexerState.getIndexerPosition.mockResolvedValue(null);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: serviceVersion });
    expect(db.checkHealth).not.toHaveBeenCalled();
  });

  it("rejects overlong query strings without affecting normal queries", async () => {
    const app = await buildServer({ queryStringLimit: 3 });

    const normalResponse = await app.inject({ method: "GET", url: "/health?a=1" });
    const overlongResponse = await app.inject({ method: "GET", url: "/health?a=12" });
    await app.close();

    expect(normalResponse.statusCode).toBe(200);
    expect(overlongResponse.statusCode).toBe(400);
  });
});

describe("readiness reflects indexer progress (#391)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.checkHealth.mockResolvedValue({ status: "up" });
  });

  it("reports not ready when no indexer position exists (untouched database)", async () => {
    indexerState.getIndexerPosition.mockResolvedValue(null);
    indexerState.hasIndexerProgress.mockReturnValue(false);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      database: "up",
      error: "indexer has not made progress",
    });
  });

  it("reports not ready when indexer position exists but lastLedger is 0", async () => {
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 0,
      chainLedger: 100,
      cursor: "cursor",
      updatedAt: new Date(),
    });
    indexerState.hasIndexerProgress.mockReturnValue(false);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      database: "up",
      error: "indexer has not made progress",
    });
  });

  it("reports ready once the indexer has made progress (lastLedger > 0)", async () => {
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 50,
      chainLedger: 100,
      cursor: "cursor",
      updatedAt: new Date(),
    });
    indexerState.hasIndexerProgress.mockReturnValue(true);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      database: "up",
      indexer: { lagLedgers: 50 },
    });
  });

  it("reports ready with lagLedgers = 0 when caught up", async () => {
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 100,
      chainLedger: 100,
      cursor: "cursor",
      updatedAt: new Date(),
    });
    indexerState.hasIndexerProgress.mockReturnValue(true);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      database: "up",
      indexer: { lagLedgers: 0 },
    });
  });

  it("keeps liveness unaffected while the indexer has made no progress", async () => {
    indexerState.getIndexerPosition.mockResolvedValue(null);
    indexerState.hasIndexerProgress.mockReturnValue(false);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });
});