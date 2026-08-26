import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkHealth, prisma } from "../src/db.js";

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
