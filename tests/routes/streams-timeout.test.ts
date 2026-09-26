import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_QUERY_TIMEOUT_MS, prisma } from "../../src/db.js";
import { streamRoutes } from "../../src/routes/streams.js";
import { buildServer } from "../../src/server.js";

// #221: a request-scoped read that exceeds its bound must fail as a server
// error rather than hanging. This drives the real repository (no module mock)
// against a query that never settles, so the bound itself is what ends the
// request.

describe("GET /streams/:id bounded read (#221)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 500 INTERNAL_SERVER_ERROR when the read exceeds its bound", async () => {
    const app = await buildServer();
    await app.register(streamRoutes);

    vi.spyOn(prisma.stream, "findUnique").mockImplementation(
      () => new Promise(() => {}) as never,
    );

    vi.useFakeTimers();
    const pending = app.inject({ method: "GET", url: "/streams/42" });
    // The query never settles; only the bound can complete the request.
    await vi.advanceTimersByTimeAsync(DEFAULT_QUERY_TIMEOUT_MS + 1);
    const response = await pending;

    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe("INTERNAL_SERVER_ERROR");
    expect(response.json().requestId).toBeTruthy();

    await app.close();
  });

  it("still serves a read that finishes inside the bound", async () => {
    const app = await buildServer();
    await app.register(streamRoutes);

    vi.spyOn(prisma.stream, "findUnique").mockResolvedValueOnce(null);

    const response = await app.inject({ method: "GET", url: "/streams/42" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
