import Fastify from "fastify";

import { beforeEach, describe, expect, it, vi } from "vitest";

// `/status` is the endpoint an operator watches to tell whether the indexer is
// keeping up, so what is tested here is exactly that: that a backfill hours
// behind the chain reports itself as behind. The database is stubbed and the
// route registered on a bare Fastify instance, so nothing but the response
// shape and the arithmetic is under test.

const indexerState = vi.hoisted(() => ({
  getIndexerPosition: vi.fn(),
  saveIndexerPosition: vi.fn(),
}));

const failedEvents = vi.hoisted(() => ({
  recordFailedEvent: vi.fn(),
  clearFailedEvent: vi.fn(),
  listFailedEvents: vi.fn(),
  countFailedEvents: vi.fn(),
  failedEventFromDecoded: vi.fn(),
}));

vi.mock("../../src/repositories/indexer-state.js", () => indexerState);
vi.mock("../../src/repositories/failed-events.js", () => failedEvents);

const { statusRoutes } = await import("../../src/routes/status.js");

const CURSOR = "0241763773516349440-0000000001";
const POLLED_AT = new Date("2025-11-14T03:00:00.000Z");

async function getStatus() {
  const app = Fastify();
  await app.register(statusRoutes);
  const response = await app.inject({ method: "GET", url: "/status" });
  await app.close();

  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default mock for countFailedEvents so tests that don't explicitly set it
  // still get a deterministic value rather than undefined.
  failedEvents.countFailedEvents.mockResolvedValue(0);
});

describe("GET /status", () => {
  it("reports the indexer's position apart from the chain's head", async () => {
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 56290013,
      chainLedger: 56999999,
      cursor: CURSOR,
      updatedAt: POLLED_AT,
    });
    failedEvents.countFailedEvents.mockResolvedValue(0);

    expect(await getStatus()).toEqual({
      indexer: {
        initialized: true,
        lastLedger: 56290013,
        cursor: CURSOR,
        updatedAt: "2025-11-14T03:00:00.000Z",
      },
      chain: { latestLedger: 56999999 },
      lagLedgers: 709986,
      failedEventCount: 0,
    });
  });

  it("shows a backfill as behind rather than level", async () => {
    // The failure this endpoint exists to catch: hundreds of thousands of
    // ledgers of work outstanding has to be visible as a number, not inferable
    // only by watching the figure fail to move.
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 56000000,
      chainLedger: 56999999,
      cursor: CURSOR,
      updatedAt: POLLED_AT,
    });
    failedEvents.countFailedEvents.mockResolvedValue(0);

    const status = await getStatus();

    expect(status.lagLedgers).toBe(999999);
    expect(status.indexer.lastLedger).toBeLessThan(status.chain.latestLedger);
  });

  it("reports no lag once the indexer has caught up", async () => {
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 56999999,
      chainLedger: 56999999,
      cursor: CURSOR,
      updatedAt: POLLED_AT,
    });
    failedEvents.countFailedEvents.mockResolvedValue(0);

    expect(await getStatus()).toMatchObject({ lagLedgers: 0 });
  });

  it("reports lag as unknown before the first poll", async () => {
    // Nothing has been recorded, so there is no distance to report. Zero would
    // read as "caught up", which is the mistake this endpoint is fixing.
    indexerState.getIndexerPosition.mockResolvedValue(null);
    failedEvents.countFailedEvents.mockResolvedValue(0);

    expect(await getStatus()).toEqual({
      indexer: { initialized: false, lastLedger: 0, cursor: null, updatedAt: null },
      chain: { latestLedger: 0 },
      lagLedgers: null,
      failedEventCount: 0,
    });
  });

  it("reports zero failedEventCount when no events have failed", async () => {
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 56290013,
      chainLedger: 56999999,
      cursor: CURSOR,
      updatedAt: POLLED_AT,
    });
    failedEvents.countFailedEvents.mockResolvedValue(0);

    const status = await getStatus();

    expect(status.failedEventCount).toBe(0);
  });

  it("reports a non-zero failedEventCount when events have failed", async () => {
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 56290013,
      chainLedger: 56999999,
      cursor: CURSOR,
      updatedAt: POLLED_AT,
    });
    failedEvents.countFailedEvents.mockResolvedValue(12);

    const status = await getStatus();

    expect(status.failedEventCount).toBe(12);
  });
});
