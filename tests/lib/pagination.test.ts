import { describe, expect, it } from "vitest";

import {
  PaginationValidationError,
  parsePagination,
} from "../../src/lib/pagination.js";

describe("parsePagination", () => {
  it("defaults to a limit of 50 and an offset of 0 when parameters are omitted", () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
  });

  it("passes through in-range values", () => {
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it("caps the limit at 100 but not below it", () => {
    expect(parsePagination({ limit: "100" }).limit).toBe(100);
    expect(parsePagination({ limit: "101" }).limit).toBe(100);
    expect(parsePagination({ limit: "100000" }).limit).toBe(100);
    expect(parsePagination({ limit: "99" }).limit).toBe(99);
  });

  it("accepts a zero limit and a zero offset", () => {
    expect(parsePagination({ limit: "0", offset: "0" })).toEqual({
      limit: 0,
      offset: 0,
    });
  });

  it("does not cap the offset", () => {
    expect(parsePagination({ offset: "100000" }).offset).toBe(100000);
  });

  describe("rejects malformed limit values", () => {
    it("rejects hex inputs", () => {
      expect(() => parsePagination({ limit: "0x10" })).toThrow(PaginationValidationError);
      expect(() => parsePagination({ limit: "0x10" })).toThrow("invalid limit");
    });

    it("rejects exponent inputs", () => {
      expect(() => parsePagination({ limit: "1e2" })).toThrow("invalid limit");
    });

    it("rejects fractional inputs", () => {
      expect(() => parsePagination({ limit: "1.9" })).toThrow("invalid limit");
      expect(() => parsePagination({ limit: "0.5" })).toThrow("invalid limit");
    });

    it("rejects negative inputs", () => {
      expect(() => parsePagination({ limit: "-5" })).toThrow("invalid limit");
      expect(() => parsePagination({ limit: "-0.5" })).toThrow("invalid limit");
    });

    it("rejects non-numeric inputs", () => {
      expect(() => parsePagination({ limit: "abc" })).toThrow("invalid limit");
      expect(() => parsePagination({ limit: "NaN" })).toThrow("invalid limit");
      expect(() => parsePagination({ limit: "Infinity" })).toThrow("invalid limit");
      expect(() => parsePagination({ limit: "-Infinity" })).toThrow("invalid limit");
    });

    it("rejects empty string inputs", () => {
      expect(() => parsePagination({ limit: "" })).toThrow("invalid limit");
    });
  });

  describe("rejects malformed offset values", () => {
    it("rejects hex inputs", () => {
      expect(() => parsePagination({ offset: "0x10" })).toThrow(PaginationValidationError);
      expect(() => parsePagination({ offset: "0x10" })).toThrow("invalid offset");
    });

    it("rejects exponent inputs", () => {
      expect(() => parsePagination({ offset: "1e2" })).toThrow("invalid offset");
    });

    it("rejects fractional inputs", () => {
      expect(() => parsePagination({ offset: "1.9" })).toThrow("invalid offset");
      expect(() => parsePagination({ offset: "0.9" })).toThrow("invalid offset");
    });

    it("rejects negative inputs", () => {
      expect(() => parsePagination({ offset: "-5" })).toThrow("invalid offset");
      expect(() => parsePagination({ offset: "-0.5" })).toThrow("invalid offset");
    });

    it("rejects non-numeric inputs", () => {
      expect(() => parsePagination({ offset: "abc" })).toThrow("invalid offset");
      expect(() => parsePagination({ offset: "NaN" })).toThrow("invalid offset");
      expect(() => parsePagination({ offset: "Infinity" })).toThrow("invalid offset");
      expect(() => parsePagination({ offset: "-Infinity" })).toThrow("invalid offset");
    });

    it("rejects empty string inputs", () => {
      expect(() => parsePagination({ offset: "" })).toThrow("invalid offset");
    });
  });
});
