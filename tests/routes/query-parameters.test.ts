import { describe, expect, it } from "vitest";

// Repeated query parameters (#519). The API rejects a repeated parameter with
// 400 instead of silently keeping the last value; see docs/query-parameters.md.

const { buildServer } = await import("../../src/server.js");

async function get(url: string) {
  const app = await buildServer();
  await app.ready();
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

describe("Repeated query parameters (#519)", () => {
  it("rejects a repeated parameter with 400", async () => {
    const response = await get("/health?sender=A&sender=B");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      error: "repeated query parameter: sender",
    });
  });

  it("rejects identical repeated values too, so the error is unambiguous", async () => {
    expect((await get("/health?sender=A&sender=A")).statusCode).toBe(400);
  });

  it("detects duplicates written with percent-encoding", async () => {
    const response = await get("/health?sender=A&%73ender=B");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty(
      "error",
      "repeated query parameter: sender",
    );
  });

  it("accepts a single parameter", async () => {
    const response = await get("/health?sender=A");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: expect.any(String) });
  });

  it("rejects an oversized query string with 400 instead of crashing", async () => {
    const app = await buildServer({ queryStringLimit: 5 });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/health?sender=abcdef",
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error", "query string too long");
  });
});
