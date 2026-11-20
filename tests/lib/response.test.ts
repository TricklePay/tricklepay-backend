import Fastify from "fastify";

import { describe, expect, it } from "vitest";

import { bigIntToString, bigIntToStringNullable, sendError } from "../../src/lib/response.js";

describe("bigIntToStringNullable", () => {
  it("returns null for null", () => {
    expect(bigIntToStringNullable(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(bigIntToStringNullable(undefined)).toBeNull();
  });

  it("stringifies zero rather than treating it as absent", () => {
    expect(bigIntToStringNullable(0n)).toBe("0");
  });

  it("preserves a bigint larger than Number.MAX_SAFE_INTEGER exactly", () => {
    const large = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(bigIntToStringNullable(large)).toBe("9007199254740993");
    // The lossy number round trip would not survive, which is the point.
    expect(String(Number(large))).not.toBe("9007199254740993");
  });

  it("preserves values beyond the uint64 range", () => {
    const huge = 340282366920938463463374607431768211455n;
    expect(bigIntToStringNullable(huge)).toBe("340282366920938463463374607431768211455");
  });

  it("stringifies Decimal-like values", () => {
    expect(bigIntToStringNullable({ toString: () => "99999999999999999999" })).toBe(
      "99999999999999999999",
    );
  });
});

describe("bigIntToString", () => {
  it("preserves a large bigint exactly", () => {
    expect(bigIntToString(BigInt(Number.MAX_SAFE_INTEGER) + 2n)).toBe("9007199254740993");
  });
});

describe("sendError", () => {
  async function callSendError(statusCode: number, code: "VALIDATION_ERROR" | "NOT_FOUND") {
    // No listen(): app.inject drives the handler in-process, so no server starts.
    const app = Fastify();
    app.get("/boom", async (request, reply) =>
      sendError(reply, request, statusCode, code, "something went wrong"),
    );
    const response = await app.inject({
      method: "GET",
      url: "/boom",
      headers: { "x-request-id": "req-123" },
    });
    await app.close();
    return response;
  }

  it("sets the requested status code", async () => {
    expect((await callSendError(400, "VALIDATION_ERROR")).statusCode).toBe(400);
    expect((await callSendError(404, "NOT_FOUND")).statusCode).toBe(404);
  });

  it("includes the code, message and request id in the body", async () => {
    const app = Fastify({ genReqId: () => "req-123" });
    app.get("/boom", async (request, reply) =>
      sendError(reply, request, 404, "NOT_FOUND", "stream not found"),
    );
    const response = await app.inject({ method: "GET", url: "/boom" });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "NOT_FOUND",
      error: "stream not found",
      requestId: "req-123",
    });
  });

  it("responds with JSON", async () => {
    const response = await callSendError(400, "VALIDATION_ERROR");
    expect(response.headers["content-type"]).toContain("application/json");
  });
});
