import { describe, expect, it } from "vitest";

import { nowSeconds, toUnixSeconds } from "../../src/lib/time.js";

describe("toUnixSeconds", () => {
  it("converts RFC 3339 timestamp string to Unix seconds as bigint", () => {
    // 2026-01-01T00:00:00Z -> 1767225600
    const result = toUnixSeconds("2026-01-01T00:00:00Z");
    expect(result).toBe(1767225600n);
  });

  it("truncates subsecond fractional seconds to whole seconds", () => {
    const result = toUnixSeconds("2026-01-01T00:00:00.999Z");
    expect(result).toBe(1767225600n);
  });

  it("returns NaN for unparseable timestamp strings", () => {
    const result = toUnixSeconds("not-a-date");
    expect(typeof result).toBe("number");
    expect(Number.isNaN(result)).toBe(true);
  });

  it("accepts a Date object", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const result = toUnixSeconds(date);
    expect(result).toBe(1767225600n);
  });

  it("accepts numeric milliseconds", () => {
    const ms = 1767225600000;
    const result = toUnixSeconds(ms);
    expect(result).toBe(1767225600n);
  });
});

describe("nowSeconds", () => {
  it("returns current timestamp in whole Unix seconds as bigint", () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const now = nowSeconds();
    const after = BigInt(Math.floor(Date.now() / 1000));

    expect(typeof now).toBe("bigint");
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
