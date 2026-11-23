import Fastify, { type FastifyInstance } from "fastify";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The X-Indexer-Lag-Ledgers header tells clients how stale a read is. The
// repository is stubbed and the hook registered on a bare Fastify instance, so
// only the hook's own rules are under test: which responses get the header,
// when it is left off, how long a value is cached, and that a database error
// never fails the request.

const indexerState = vi.hoisted(() => ({
  getIndexerPosition: vi.fn(),
}));

vi.mock("../src/repositories/indexer-state.js", () => indexerState);

const HEADER = "x-indexer-lag-ledgers";
const T0 = new Date("2025-11-14T03:00:00.000Z");

function position(lastLedger: number, chainLedger: number) {
  return { lastLedger, chainLedger, cursor: "c", updatedAt: T0 };
}

let app: FastifyInstance;

beforeEach(async () => {
  // The cache is module state, so each test loads a fresh copy of the hook.
  vi.resetModules();
  indexerState.getIndexerPosition.mockReset();
  // Only Date is faked: Fastify's inject relies on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);

  const { registerIndexerLagHook } = await import("../src/indexer-lag-hook.js");
  app = Fastify();
  registerIndexerLagHook(app);
  for (const url of ["/streams", "/health", "/health/live", "/ready", "/metrics"]) {
    app.get(url, async () => ({ ok: true }));
  }
  app.post("/streams", async () => ({ ok: true }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

describe("X-Indexer-Lag-Ledgers header", () => {
  it("reports chainLedger minus lastLedger on GET responses", async () => {
    indexerState.getIndexerPosition.mockResolvedValue(position(1_000, 1_042));

    const res = await app.inject({ method: "GET", url: "/streams" });

    expect(res.statusCode).toBe(200);
    expect(res.headers[HEADER]).toBe("42");
  });

  it("clamps a negative lag to zero", async () => {
    indexerState.getIndexerPosition.mockResolvedValue(position(1_050, 1_000));

    const res = await app.inject({ method: "GET", url: "/streams" });

    expect(res.headers[HEADER]).toBe("0");
  });

  it("is omitted before the first poll has recorded a position", async () => {
    indexerState.getIndexerPosition.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/streams" });

    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty(HEADER);
  });

  it("is omitted on non-GET requests without touching the repository", async () => {
    indexerState.getIndexerPosition.mockResolvedValue(position(1_000, 1_042));

    const res = await app.inject({ method: "POST", url: "/streams" });

    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty(HEADER);
    expect(indexerState.getIndexerPosition).not.toHaveBeenCalled();
  });

  it.each(["/health", "/ready", "/metrics"])(
    "is omitted on the excluded route %s",
    async (url) => {
      indexerState.getIndexerPosition.mockResolvedValue(position(1_000, 1_042));

      const res = await app.inject({ method: "GET", url });

      expect(res.statusCode).toBe(200);
      expect(res.headers).not.toHaveProperty(HEADER);
      expect(indexerState.getIndexerPosition).not.toHaveBeenCalled();
    },
  );
});

describe("lag cache", () => {
  it("reuses the value for two seconds, then reads the repository again", async () => {
    indexerState.getIndexerPosition
      .mockResolvedValueOnce(position(1_000, 1_010))
      .mockResolvedValueOnce(position(1_000, 1_020));

    const first = await app.inject({ method: "GET", url: "/streams" });
    expect(first.headers[HEADER]).toBe("10");

    // Just inside the TTL: still served from the cache.
    vi.setSystemTime(T0.getTime() + 1_999);
    const cached = await app.inject({ method: "GET", url: "/streams" });
    expect(cached.headers[HEADER]).toBe("10");
    expect(indexerState.getIndexerPosition).toHaveBeenCalledTimes(1);

    // At the TTL the entry has expired and the new lag is read.
    vi.setSystemTime(T0.getTime() + 2_000);
    const refreshed = await app.inject({ method: "GET", url: "/streams" });
    expect(refreshed.headers[HEADER]).toBe("20");
    expect(indexerState.getIndexerPosition).toHaveBeenCalledTimes(2);
  });

  it("does not cache the absence of a position", async () => {
    indexerState.getIndexerPosition
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(position(1_000, 1_005));

    const before = await app.inject({ method: "GET", url: "/streams" });
    expect(before.headers).not.toHaveProperty(HEADER);

    // The first poll lands moments later; the header appears straight away.
    vi.setSystemTime(T0.getTime() + 100);
    const after = await app.inject({ method: "GET", url: "/streams" });
    expect(after.headers[HEADER]).toBe("5");
  });
});

describe("repository failure", () => {
  it("serves the response without the header when the repository throws", async () => {
    indexerState.getIndexerPosition.mockRejectedValue(new Error("connection refused"));

    const res = await app.inject({ method: "GET", url: "/streams" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers).not.toHaveProperty(HEADER);
  });

  it("recovers once the repository answers again", async () => {
    indexerState.getIndexerPosition
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(position(1_000, 1_007));

    const failed = await app.inject({ method: "GET", url: "/streams" });
    expect(failed.statusCode).toBe(200);
    expect(failed.headers).not.toHaveProperty(HEADER);

    const ok = await app.inject({ method: "GET", url: "/streams" });
    expect(ok.headers[HEADER]).toBe("7");
  });
});
