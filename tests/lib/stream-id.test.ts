import { describe, expect, it } from "vitest";

import { MAX_STREAM_ID, MAX_UINT64, parseStreamId } from "../../src/lib/stream-id.js";

// Pure unit tests for the stream id parser — no Fastify instance, no HTTP
// request. It used to be reachable only through the stream routes' param
// handling; these exercise it directly.

describe("parseStreamId", () => {
  it("parses a plain decimal id", () => {
    expect(parseStreamId("42")).toBe(42n);
  });

  it("parses zero", () => {
    expect(parseStreamId("0")).toBe(0n);
  });

  it("parses the maximum signed BIGINT value", () => {
    expect(parseStreamId(MAX_STREAM_ID.toString())).toBe(MAX_STREAM_ID);
  });

  it("trims surrounding whitespace", () => {
    expect(parseStreamId("  42  ")).toBe(42n);
  });

  it("parses a value with leading zeros", () => {
    expect(parseStreamId("007")).toBe(7n);
  });

  it("returns null for undefined", () => {
    expect(parseStreamId(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseStreamId("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(parseStreamId("   ")).toBeNull();
  });

  it("returns null for a negative number", () => {
    expect(parseStreamId("-1")).toBeNull();
  });

  it("returns null for a decimal number", () => {
    expect(parseStreamId("1.5")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseStreamId("abc")).toBeNull();
  });

  it.each([MAX_STREAM_ID + 1n, MAX_UINT64, MAX_UINT64 + 1n])(
    "returns null for an id outside the database BIGINT range: %s",
    (id) => {
      expect(parseStreamId(id.toString())).toBeNull();
    },
  );

  it("returns null for scientific notation or other non-digit formats", () => {
    expect(parseStreamId("1e10")).toBeNull();
  });

  it("returns null for a value with internal whitespace", () => {
    expect(parseStreamId("4 2")).toBeNull();
  });

  it("returns null for a hex-prefixed value", () => {
    expect(parseStreamId("0x2a")).toBeNull();
  });
});
