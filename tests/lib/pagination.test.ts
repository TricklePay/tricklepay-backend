import { describe, expect, it } from "vitest";

import { parsePagination } from "../../src/lib/pagination.js";

describe("parsePagination", () => {
  it("uses the defaults when values are absent or invalid", () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: "nope", offset: "-1" })).toEqual({ limit: 50, offset: 0 });
  });

  it("floors values and clamps the limit", () => {
    expect(parsePagination({ limit: "150.9", offset: "4.9" })).toEqual({
      limit: 100,
      offset: 4,
    });
  });

  it("defaults to a limit of 50 and an offset of 0", () => {
    const { limit, offset } = parsePagination({});
    expect(limit).toBe(50);
    expect(offset).toBe(0);
  });

  it("passes through in-range values", () => {
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({ limit: 10, offset: 20 });
  });

  it("caps the limit at 100 but not below it", () => {
    expect(parsePagination({ limit: "100" }).limit).toBe(100);
    expect(parsePagination({ limit: "101" }).limit).toBe(100);
    expect(parsePagination({ limit: "100000" }).limit).toBe(100);
    expect(parsePagination({ limit: "99" }).limit).toBe(99);
  });

  it("does not cap the offset", () => {
    expect(parsePagination({ offset: "100000" }).offset).toBe(100000);
  });

  it("rounds fractional values down", () => {
    expect(parsePagination({ limit: "7.9", offset: "3.9" })).toEqual({ limit: 7, offset: 3 });
    expect(parsePagination({ limit: "0.5" }).limit).toBe(50);
    expect(parsePagination({ offset: "0.9" }).offset).toBe(0);
  });

  it("falls back for a zero limit, and accepts a zero offset", () => {
    expect(parsePagination({ limit: "0", offset: "0" })).toEqual({ limit: 50, offset: 0 });
  });

  it("falls back for negative values", () => {
    expect(parsePagination({ limit: "-5", offset: "-5" })).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: "-0.5", offset: "-0.5" })).toEqual({ limit: 50, offset: 0 });
  });

  it("falls back for NaN", () => {
    expect(parsePagination({ limit: "NaN", offset: "NaN" })).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: "abc", offset: "abc" })).toEqual({ limit: 50, offset: 0 });
  });

  it("falls back for Infinity", () => {
    expect(parsePagination({ limit: "Infinity", offset: "Infinity" })).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(parsePagination({ limit: "-Infinity", offset: "-Infinity" })).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  it("falls back for empty strings", () => {
    expect(parsePagination({ limit: "", offset: "" })).toEqual({ limit: 50, offset: 0 });
  });
});
