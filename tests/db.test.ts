import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_QUERY_TIMEOUT_MS,
  QueryTimeoutError,
  checkHealth,
  disconnect,
  prisma,
  withQueryTimeout,
} from "../src/db.js";

describe("checkHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("succeeds against a healthy database", async () => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ "?column?": 1 }]);
    
    // We cannot await checkHealth directly while fake timers are active unless we
    // let the event loop process promises or resolve the query raw immediately.
    // Since mockResolvedValueOnce resolves immediately, this is fine.
    const result = await checkHealth();
    
    expect(result).toEqual({ status: "up" });
  });

  it("times out predictably", async () => {
    // A promise that never resolves
    vi.spyOn(prisma, "$queryRaw").mockImplementationOnce(() => new Promise(() => {}) as any);
    
    const promise = checkHealth(10);
    vi.advanceTimersByTime(15);
    
    const result = await promise;
    expect(result).toEqual({ status: "down", error: "timeout" });
  });

  it("normalizes errors without leaking credentials", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(
      new Error("P1000: Authentication failed: postgresql://tricklepay:secret@localhost:5432/tricklepay")
    );
    
    const result = await checkHealth();
    
    expect(result).toEqual({ status: "down", error: "database unavailable" });
  });
});

describe("disconnect", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("closes the shared prisma connection pool", async () => {
    const spy = vi.spyOn(prisma, "$disconnect").mockResolvedValueOnce(undefined);

    await disconnect();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("withQueryTimeout (#221)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a query that finishes inside the bound", async () => {
    await expect(withQueryTimeout(Promise.resolve("row"), 50)).resolves.toBe("row");
  });

  it("still rejects when the query itself fails inside the bound", async () => {
    const failure = new Error("connection reset");
    await expect(withQueryTimeout(Promise.reject(failure), 50)).rejects.toBe(failure);
  });

  it("rejects a query that exceeds its bound rather than hanging", async () => {
    vi.useFakeTimers();

    const pending = withQueryTimeout(new Promise(() => {}), 25);
    const assertion = expect(pending).rejects.toBeInstanceOf(QueryTimeoutError);

    vi.advanceTimersByTime(30);

    await assertion;
  });

  it("documents a 5s default bound", () => {
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBe(5000);
  });
});
