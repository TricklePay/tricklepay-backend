import { describe, expect, it } from "vitest";

import { parseQueryString } from "../src/query-string-parser.js";

describe("parseQueryString (#242)", () => {
  it("parses a simple key=value pair", () => {
    expect(parseQueryString("foo=bar")).toEqual({ foo: "bar" });
  });

  it("parses multiple key=value pairs", () => {
    expect(parseQueryString("a=1&b=2&c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns an empty object for an empty string", () => {
    expect(parseQueryString("")).toEqual({});
  });

  it("decodes percent-encoded characters", () => {
    expect(parseQueryString("name=hello%20world")).toEqual({ name: "hello world" });
  });

  it("last-write-wins for duplicate keys", () => {
    expect(parseQueryString("x=first&x=second")).toEqual({ x: "second" });
  });

  it("handles keys with no value", () => {
    const result = parseQueryString("flag");
    expect(result).toHaveProperty("flag");
    expect(result.flag).toBe("");
  });

  it("handles special characters in values", () => {
    expect(parseQueryString("q=foo%3Dbar")).toEqual({ q: "foo=bar" });
  });
});
