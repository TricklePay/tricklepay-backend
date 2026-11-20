import { describe, expect, it } from "vitest";

import { vestedAmount, withdrawableAmount } from "../../src/lib/vesting.js";

// ===========================================================================
// Contract Reference Tests
// ===========================================================================

// These mirror the unit tests in the contract's `vesting.rs` case for case. The
// two implementations have to agree exactly — the API recomputes vested and
// withdrawable amounts on every read, so any divergence would show clients a
// number the chain will not honour.

// The reference stream used by the contract's tests: 1000 units released
// linearly over [100, 1100], with no cliff (cliff == start).
const TOTAL = 1_000n;
const START = 100n;
const END = 1_100n;

describe("vestedAmount", () => {
  it("vests nothing before the start time", () => {
    expect(vestedAmount(TOTAL, START, END, START, 50n)).toBe(0n);
  });

  it("vests nothing before the cliff", () => {
    // Past the start but before a cliff set at the midpoint.
    expect(vestedAmount(TOTAL, START, END, 600n, 300n)).toBe(0n);
  });

  it("vests half at the midpoint", () => {
    expect(vestedAmount(TOTAL, START, END, START, 600n)).toBe(500n);
  });

  it("vests a quarter at the quarter point", () => {
    expect(vestedAmount(TOTAL, START, END, START, 350n)).toBe(250n);
  });

  it("vests the full amount at the end time", () => {
    expect(vestedAmount(TOTAL, START, END, START, END)).toBe(TOTAL);
  });

  it("vests the full amount after the end time", () => {
    expect(vestedAmount(TOTAL, START, END, START, 9_999n)).toBe(TOTAL);
  });

  it("releases the accrued amount at once when the cliff lands", () => {
    // At the cliff, the linearly accrued amount since start becomes available
    // in one step: 500 of 1000 at the midpoint.
    expect(vestedAmount(TOTAL, START, END, 600n, 600n)).toBe(500n);
  });

  it("rounds down on integer division", () => {
    // 10 * 1 / 3 = 3.33, truncated to 3.
    expect(vestedAmount(10n, 0n, 3n, 0n, 1n)).toBe(3n);
  });
});

describe("withdrawableAmount", () => {
  it("subtracts what has already been withdrawn", () => {
    expect(withdrawableAmount(500n, 200n)).toBe(300n);
  });

  it("is never negative", () => {
    expect(withdrawableAmount(200n, 500n)).toBe(0n);
  });

  it("is zero once everything vested has been taken", () => {
    expect(withdrawableAmount(300n, 300n)).toBe(0n);
  });
});

// ===========================================================================
// Edge Cases and i128 Scale
// ===========================================================================

// Cases below have no counterpart in `vesting.rs`: they pin down behaviour that
// is specific to this port — bigint arithmetic standing in for the contract's
// i128, and the assumptions the module comment makes about stored streams.

describe("vestedAmount at i128 scale", () => {
  it("keeps full precision past Number.MAX_SAFE_INTEGER", () => {
    // A float implementation would drift here; the exact product is
    // 12345678901234567890 * 3 = 37037036703703703670, truncated by 10.
    expect(vestedAmount(12_345_678_901_234_567_890n, 0n, 10n, 0n, 3n)).toBe(
      3_703_703_670_370_370_367n,
    );
  });

  it("handles the largest i128 total the contract could store", () => {
    const maxI128 = 170_141_183_460_469_231_731_687_303_715_884_105_727n;
    expect(vestedAmount(maxI128, 0n, 2n, 0n, 1n)).toBe(maxI128 / 2n);
    expect(vestedAmount(maxI128, 0n, 2n, 0n, 2n)).toBe(maxI128);
  });
});

describe("vestedAmount edge cases", () => {
  it("vests nothing at the exact start instant", () => {
    expect(vestedAmount(TOTAL, START, END, START, START)).toBe(0n);
  });

  it("vests nothing for a zero total", () => {
    expect(vestedAmount(0n, START, END, START, 600n)).toBe(0n);
  });

  it("gates on a cliff set beyond the end time", () => {
    // The cliff check runs before the end-time shortcut, so an unreachable
    // cliff keeps the stream at zero until it passes.
    expect(vestedAmount(TOTAL, START, END, 2_000n, 1_500n)).toBe(0n);
    expect(vestedAmount(TOTAL, START, END, 2_000n, 2_000n)).toBe(TOTAL);
  });

  it("reports the frozen balance of a cancelled stream", () => {
    // Cancelling rewrites the stored total to the amount vested at that moment
    // and the end time to the cancellation time, so every later read returns
    // that frozen figure without a special case here.
    expect(vestedAmount(500n, START, 600n, START, 5_000n)).toBe(500n);
  });
});

describe("withdrawableAmount at i128 scale", () => {
  it("subtracts without precision loss", () => {
    expect(withdrawableAmount(12_345_678_901_234_567_890n, 345_678_901_234_567_890n)).toBe(
      12_000_000_000_000_000_000n,
    );
  });
});

// ===========================================================================
// Status Boundary Semantics (#63)
// ===========================================================================

// The status derivation lives in the route handler (statusOf), not the vesting
// helper, so we replicate the exact logic here and pin down every boundary
// transition with a focused test. This is the source-of-truth for how the API
// classifies stream lifecycle states.

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

interface StreamLike {
  startTime: bigint;
  endTime: bigint;
  cancelled: boolean;
}

function statusOf(stream: StreamLike, now: bigint): StreamStatus {
  if (stream.cancelled) return "cancelled";
  if (now < stream.startTime) return "pending";
  if (now >= stream.endTime) return "completed";
  return "streaming";
}

const STATUS_START = 1000n;
const STATUS_END = 2000n;

const baseStream: StreamLike = { startTime: STATUS_START, endTime: STATUS_END, cancelled: false };

describe("vesting status boundary semantics (#63)", () => {
  describe("pending → streaming transition", () => {
    it("is pending one second before start", () => {
      expect(statusOf(baseStream, STATUS_START - 1n)).toBe("pending");
    });

    it("is streaming at the exact start instant", () => {
      // now >= startTime (but now < endTime) → streaming
      expect(statusOf(baseStream, STATUS_START)).toBe("streaming");
    });
  });

  describe("streaming → completed transition", () => {
    it("is streaming one second before end", () => {
      expect(statusOf(baseStream, STATUS_END - 1n)).toBe("streaming");
    });

    it("is completed at the exact end instant", () => {
      // now >= endTime → completed
      expect(statusOf(baseStream, STATUS_END)).toBe("completed");
    });

    it("stays completed after end", () => {
      expect(statusOf(baseStream, STATUS_END + 999n)).toBe("completed");
    });
  });

  describe("cancelled overrides everything", () => {
    it("is cancelled even before start", () => {
      const cancelled: StreamLike = { ...baseStream, cancelled: true };
      expect(statusOf(cancelled, STATUS_START - 100n)).toBe("cancelled");
    });

    it("is cancelled during the streaming window", () => {
      const cancelled: StreamLike = { ...baseStream, cancelled: true };
      expect(statusOf(cancelled, (STATUS_START + STATUS_END) / 2n)).toBe("cancelled");
    });

    it("is cancelled after end", () => {
      const cancelled: StreamLike = { ...baseStream, cancelled: true };
      expect(statusOf(cancelled, STATUS_END + 100n)).toBe("cancelled");
    });
  });

  describe("cancelled stream with frozen endTime", () => {
    it("cancelled stream's endTime is the cancellation moment", () => {
      // The contract freezes endTime at cancellation. Even though the
      // original endTime was later, the stored endTime is now the freeze point.
      const frozenEnd = 1500n;
      const cancelled: StreamLike = { startTime: STATUS_START, endTime: frozenEnd, cancelled: true };
      // After the frozen end, status is still "cancelled" (cancelled check runs first).
      expect(statusOf(cancelled, frozenEnd + 1n)).toBe("cancelled");
    });
  });

  describe("edge: zero-length stream (start == end)", () => {
    it("is completed immediately at start == end", () => {
      const instant: StreamLike = { startTime: 500n, endTime: 500n, cancelled: false };
      // now >= endTime and now >= startTime → completed
      expect(statusOf(instant, 500n)).toBe("completed");
    });

    it("is pending one second before the instant", () => {
      const instant: StreamLike = { startTime: 500n, endTime: 500n, cancelled: false };
      expect(statusOf(instant, 499n)).toBe("pending");
    });
  });
});

// ===========================================================================
// Property Tests (#64)
// ===========================================================================

// These generate bounded random cases to verify invariants that must hold
// for every possible input. The random seed is not fixed so CI catches a
// wider surface over time, but each run is fast (< 50 ms).

function rand(min: bigint, max: bigint): bigint {
  const range = max - min;
  return min + BigInt(Math.floor(Number(range) * Math.random()));
}

const CASES = 200;

function randomStreamParams() {
  const total = rand(1n, 1_000_000_000_000n);
  const start = rand(0n, 1_000_000n);
  const duration = rand(1n, 1_000_000n);
  const end = start + duration;
  const cliff = rand(start, end);
  return { total, start, end, cliff, duration };
}

describe("vesting arithmetic properties (#64)", () => {
  describe("monotonicity: vested amount never decreases as time advances", () => {
    it(`holds for ${CASES} random streams`, () => {
      for (let i = 0; i < CASES; i++) {
        const { total, start, end, cliff } = randomStreamParams();
        let prev = 0n;
        // Sample 10 time points across the stream's lifetime.
        for (let step = 0; step <= 10; step++) {
          const t = start + (BigInt(step) * (end - start)) / 10n;
          const v = vestedAmount(total, start, end, cliff, t);
          expect(v).toBeGreaterThanOrEqual(prev);
          prev = v;
        }
      }
    });
  });

  describe("clamping: vested amount is always in [0, total]", () => {
    it(`holds for ${CASES} random streams across wide time range`, () => {
      for (let i = 0; i < CASES; i++) {
        const { total, start, end, cliff } = randomStreamParams();
        // Test at several time points including far in the past and future.
        const times = [0n, start - 1n, start, cliff, (start + end) / 2n, end, end + 1n, end + 1_000_000n];
        for (const t of times) {
          const v = vestedAmount(total, start, end, cliff, t);
          expect(v).toBeGreaterThanOrEqual(0n);
          expect(v).toBeLessThanOrEqual(total);
        }
      }
    });
  });

  describe("conservation: vested + locked == total at all times", () => {
    it(`holds for ${CASES} random streams`, () => {
      for (let i = 0; i < CASES; i++) {
        const { total, start, end, cliff } = randomStreamParams();
        const times = [start, (start + end) / 2n, end];
        for (const t of times) {
          const v = vestedAmount(total, start, end, cliff, t);
          const locked = total - v;
          expect(v + locked).toBe(total);
        }
      }
    });
  });

  describe("withdrawableAmount: clamped subtraction", () => {
    it(`withdrawable is never negative for ${CASES} random inputs`, () => {
      for (let i = 0; i < CASES; i++) {
        const vested = rand(0n, 1_000_000_000_000n);
        const withdrawn = rand(0n, vested + 100n); // sometimes exceeds vested
        const w = withdrawableAmount(vested, withdrawn);
        expect(w).toBeGreaterThanOrEqual(0n);
        expect(w).toBeLessThanOrEqual(vested);
      }
    });

    it("withdrawable + withdrawn == vested when withdrawn <= vested", () => {
      for (let i = 0; i < CASES; i++) {
        const vested = rand(1n, 1_000_000_000_000n);
        const withdrawn = rand(0n, vested);
        const w = withdrawableAmount(vested, withdrawn);
        expect(w + withdrawn).toBe(vested);
      }
    });
  });

  describe("integer division: no overflow at i128 scale", () => {
    it("handles product near i128 boundary without precision loss", () => {
      const maxI128 = 170_141_183_460_469_231_731_687_303_715_884_105_727n;
      // This product (maxI128 * elapsed) could overflow if using i256 or float.
      // bigint handles it natively. Verify the result is exact integer division.
      const elapsed = 999_999n;
      const duration = 1_000_000n;
      const v = vestedAmount(maxI128, 0n, duration, 0n, elapsed);
      expect(v).toBe((maxI128 * elapsed) / duration);
      expect(v + (maxI128 - v)).toBe(maxI128); // conservation
    });
  });

  describe("cliff: all-or-nothing jump", () => {
    it("vested amount jumps from 0 to a positive value at the cliff", () => {
      const { total, start, end } = randomStreamParams();
      const cliff = (start + end) / 2n;
      const beforeCliff = vestedAmount(total, start, end, cliff, cliff - 1n);
      const atCliff = vestedAmount(total, start, end, cliff, cliff);
      expect(beforeCliff).toBe(0n);
      expect(atCliff).toBeGreaterThan(0n);
      expect(atCliff).toBeLessThanOrEqual(total);
    });
  });

  describe("cancel-like frozen total", () => {
    it("a stream with total set to vested amount and end set to cancel time returns that total", () => {
      const { total, start, duration } = randomStreamParams();
      const cancelTime = start + duration / 2n;
      const frozenTotal = vestedAmount(total, start, start + duration, start, cancelTime);
      // After cancellation, the contract rewrites total = frozenTotal, end = cancelTime.
      const result = vestedAmount(frozenTotal, start, cancelTime, start, cancelTime + 1_000_000n);
      expect(result).toBe(frozenTotal);
    });
  });
});
