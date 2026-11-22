import { describe, expect, it } from "vitest";

import { MAX_INT128, MAX_UINT64, parseUnsignedInteger } from "../../src/lib/unsigned-integer.js";

// The shared parser behind stream ids, `at` timestamps and amount filters.
// Callers differ only in the maximum they pass.

describe("parseUnsignedInteger", () => {
  it("parses a plain decimal value", () => {
    expect(parseUnsignedInteger("42", 100n)).toBe(42n);
  });

  it("parses zero", () => {
    expect(parseUnsignedInteger("0", 100n)).toBe(0n);
  });

  it("accepts a value equal to the maximum", () => {
    expect(parseUnsignedInteger("100", 100n)).toBe(100n);
  });

  it("returns null for a value one past the maximum", () => {
    expect(parseUnsignedInteger("101", 100n)).toBeNull();
  });

  it("applies the u64 bound", () => {
    expect(parseUnsignedInteger(MAX_UINT64.toString(), MAX_UINT64)).toBe(MAX_UINT64);
    expect(parseUnsignedInteger((MAX_UINT64 + 1n).toString(), MAX_UINT64)).toBeNull();
  });

  it("applies the i128 bound", () => {
    expect(parseUnsignedInteger(MAX_INT128.toString(), MAX_INT128)).toBe(MAX_INT128);
    expect(parseUnsignedInteger((MAX_INT128 + 1n).toString(), MAX_INT128)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseUnsignedInteger("  7\t", 100n)).toBe(7n);
  });

  it("parses a value with leading zeros", () => {
    expect(parseUnsignedInteger("007", 100n)).toBe(7n);
  });

  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a negative number", "-1"],
    ["an explicit plus sign", "+1"],
    ["a decimal number", "1.5"],
    ["scientific notation", "1e3"],
    ["a hex prefix", "0x2a"],
    ["internal whitespace", "4 2"],
    ["non-numeric input", "abc"],
  ])("returns null for %s", (_label, raw) => {
    expect(parseUnsignedInteger(raw, MAX_UINT64)).toBeNull();
  });
});
