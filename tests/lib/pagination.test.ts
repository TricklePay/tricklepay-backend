import { describe, expect, it } from "vitest";
import { InvalidPaginationParameter, parsePagination } from "../../src/lib/pagination.js";

describe("parsePagination", () => {
  it("uses defaults only when the parameters are absent", () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({ limit: 10, offset: 20 });
    expect(parsePagination({ offset: "0" })).toEqual({ limit: 50, offset: 0 });
  });

  it("caps positive decimal limit values to 100", () => {
    expect(parsePagination({ limit: "100" }).limit).toBe(100);
    expect(parsePagination({ limit: "101" }).limit).toBe(100);
    expect(parsePagination({ limit: "100000" }).limit).toBe(100);
  });

  it("accepts large safe integer offsets without silently capping", () => {
    expect(parsePagination({ offset: "100000" }).offset).toBe(100000);
  });

  it.each(["", " ", "0", "-1", "0x10", "1e2", "7.9", "abc", "Infinity", "01", "9007199254740992"])(
    "rejects invalid limit %j", (limit) => {
      expect(() => parsePagination({ limit })).toThrow(InvalidPaginationParameter);
      expect(() => parsePagination({ limit })).toThrow("invalid limit");
    },
  );

  it.each(["", " ", "-3", "0x10", "1e2", "1.9", "abc", "Infinity", "01", "9007199254740992"])(
    "rejects invalid offset %j", (offset) => {
      expect(() => parsePagination({ offset })).toThrow(InvalidPaginationParameter);
      expect(() => parsePagination({ offset })).toThrow("invalid offset");
    },
  );
});
