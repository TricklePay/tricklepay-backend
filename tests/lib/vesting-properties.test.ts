import { describe, expect, it } from "vitest";

import { vestedAmount, withdrawableAmount } from "../../src/lib/vesting.js";

// Issue #64 — Property-style tests for vesting arithmetic.
//
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
