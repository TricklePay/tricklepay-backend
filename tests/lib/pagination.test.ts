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
});
