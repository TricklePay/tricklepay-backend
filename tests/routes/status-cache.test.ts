import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for status route cache-control header.

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

async function getStatus() {
  const app = Fastify();
  await app.register(statusRoutes);
  const response = await app.inject({ method: "GET", url: "/status" });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
  failedEvents.countFailedEvents.mockResolvedValue(0);
});

describe("GET /status", () => {
  it("returns no-store cache-control header", async () => {
    indexerState.getIndexerPosition.mockResolvedValue(null);
    const response = await getStatus();
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
