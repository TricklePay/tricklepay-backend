import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

// Integration-level smoke tests for the split server setup (#240).
// Each concern lives in its own module; these tests verify the composed
// behaviour is unchanged after the split.

describe("buildServer (split setup #240)", () => {
  it("responds 200 on GET /health", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; version: string }>();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("attaches x-request-id header to every response", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("returns a structured error body for unmatched routes", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    await app.close();
    expect(res.statusCode).toBe(404);
    const body = res.json<{ code: string; error: string; requestId: string }>();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.requestId).toBeTruthy();
  });

  it("enforces the query string length limit when configured", async () => {
    const app = await buildServer({ queryStringLimit: 10 });
    const res = await app.inject({
      method: "GET",
      url: "/health?" + "a".repeat(11),
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; error: string }>();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toBe("query string too long");
  });

  it("redacts credentials in error messages before sending to the client", async () => {
    const app = await buildServer();
    app.get("/fail", async () => {
      const err = new Error(
        "connect postgres://user:pass@db.internal/db failed",
      ) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/fail" });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).not.toContain("pass");
    expect(res.json().error).toContain("[redacted]");
  });
});
