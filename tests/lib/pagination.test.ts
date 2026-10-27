import { describe, expect, it } from "vitest";

import { InvalidPaginationParameter, parsePagination } from "../../src/lib/pagination.js";

describe("parsePagination", () => {
  it("uses defaults only when parameters are absent", () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({ limit: 10, offset: 20 });
    expect(parsePagination({ offset: "0" })).toEqual({ limit: 50, offset: 0 });
  });

  it("caps the limit at 100 but not below it", () => {
    expect(parsePagination({ limit: "100" }).limit).toBe(100);
    expect(parsePagination({ limit: "101" }).limit).toBe(100);
    expect(parsePagination({ limit: "100000" }).limit).toBe(100);
    expect(parsePagination({ limit: "99" }).limit).toBe(99);
  });

  it("does not cap valid safe-integer offsets", () => {
    expect(parsePagination({ offset: "100000" }).offset).toBe(100000);
  });

  it.each(["", " ", "0", "-1", "-5", "0x10", "1e2", "7.9", "0.5", "abc", "NaN", "Infinity", "-Infinity", "01", "9007199254740992"])(
    "rejects malformed limit %j",
    (limit) => {
      expect(() => parsePagination({ limit })).toThrow(InvalidPaginationParameter);
      expect(() => parsePagination({ limit })).toThrow("invalid limit");
    },
  );

  it.each(["", " ", "-1", "-3", "-0.5", "0x10", "1e2", "1.9", "0.9", "abc", "NaN", "Infinity", "-Infinity", "01", "9007199254740992"])(
    "rejects malformed offset %j",
    (offset) => {
      expect(() => parsePagination({ offset })).toThrow(InvalidPaginationParameter);
      expect(() => parsePagination({ offset })).toThrow("invalid offset");
    },
  );
});
