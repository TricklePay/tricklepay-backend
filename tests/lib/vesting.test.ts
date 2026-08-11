import { describe, expect, it } from "vitest";
import { vestedAmount, withdrawableAmount } from "../../src/lib/vesting.js";

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
