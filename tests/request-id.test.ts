import { describe, expect, it } from "vitest";

import {
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  sanitizeRequestId,
} from "../src/request-id.js";

// Direct unit tests for the request id sanitisation rules (#238), independent
// of the server wiring. `tests/routes/request-id.test.ts` covers the same rules
// end-to-end through Fastify.

describe("sanitizeRequestId", () => {
  it("exposes the canonical request id header name", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it("keeps a safe client id unchanged", () => {
    expect(sanitizeRequestId("client-trace-42")).toBe("client-trace-42");
    expect(sanitizeRequestId("abc_DEF.123")).toBe("abc_DEF.123");
  });

  it("accepts an id of exactly the maximum length", () => {
    const maxId = "a".repeat(MAX_REQUEST_ID_LENGTH);
    expect(sanitizeRequestId(maxId)).toBe(maxId);
  });

  it("rejects an oversized id", () => {
    const tooLong = "a".repeat(MAX_REQUEST_ID_LENGTH + 1);
    expect(sanitizeRequestId(tooLong)).toBeUndefined();
  });

  it("rejects an empty id", () => {
    expect(sanitizeRequestId("")).toBeUndefined();
  });

  it("rejects ids with unsafe or non-leading characters", () => {
    for (const unsafe of [
      "has spaces",
      "semi;colon",
      'quote"mark',
      "$dollar$",
      ".leading-dot",
      "-leading-dash",
      "_leading-underscore",
      "new\nline",
    ]) {
      expect(sanitizeRequestId(unsafe)).toBeUndefined();
    }
  });

  it("rejects non-string values", () => {
    expect(sanitizeRequestId(undefined)).toBeUndefined();
    expect(sanitizeRequestId(null)).toBeUndefined();
    expect(sanitizeRequestId(42)).toBeUndefined();
    expect(sanitizeRequestId(["x-request-id"])).toBeUndefined();
  });
});
