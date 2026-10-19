import { describe, expect, it, vi } from "vitest";

import { prisma } from "../src/db.js";
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

  it("keeps operational probes reachable after the API quota is exhausted", async () => {
    const app = await buildServer({ rateLimitMax: 2, rateLimitWindowMs: 60000 });
    app.get("/streams", async () => ({ ok: true }));
    app.get("/metrics", async () => "metrics ok");

    try {
      const first = await app.inject({ method: "GET", url: "/streams" });
      const second = await app.inject({ method: "GET", url: "/streams" });
      const limited = await app.inject({ method: "GET", url: "/streams" });
      expect([first.statusCode, second.statusCode, limited.statusCode]).toEqual([200, 200, 429]);
      for (const route of ["/health", "/health?probe=1", "/metrics", "/metrics?probe=1"]) {
        const res = await app.inject({ method: "GET", url: route });
        expect(res.statusCode).toBe(200);
      }
      const query = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("database down"));
      try {
        const ready = await app.inject({ method: "GET", url: "/ready" });
        expect(ready.statusCode).toBe(503); // dependency failure, not a rate-limit response
      } finally {
        query.mockRestore();
      }
      // A probe must not reset or consume the exhausted client-IP bucket.
      expect((await app.inject({ method: "GET", url: "/streams" })).statusCode).toBe(429);
    } finally {
      await app.close();
    }
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
