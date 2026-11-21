import { describe, expect, it } from "vitest";

import { parseAmount, parseAtTimestamp } from "../../src/lib/stream-query.js";
import { MAX_INT128, MAX_UINT64 } from "../../src/lib/unsigned-integer.js";

describe("parseAtTimestamp", () => {
  it("parses a Unix timestamp", () => {
    expect(parseAtTimestamp("1735689600")).toBe(1735689600n);
  });

  it("is bounded by u64", () => {
    expect(parseAtTimestamp(MAX_UINT64.toString())).toBe(MAX_UINT64);
    expect(parseAtTimestamp((MAX_UINT64 + 1n).toString())).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(parseAtTimestamp("-1")).toBeNull();
    expect(parseAtTimestamp("1.5")).toBeNull();
  });
});

describe("parseAmount", () => {
  it("parses an amount above the u64 range", () => {
    const amount = (MAX_UINT64 + 1n).toString();
    expect(parseAmount(amount)).toBe(MAX_UINT64 + 1n);
  });

  it("is bounded by i128", () => {
    expect(parseAmount(MAX_INT128.toString())).toBe(MAX_INT128);
    expect(parseAmount((MAX_INT128 + 1n).toString())).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
});
