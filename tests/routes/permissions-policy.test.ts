import { describe, expect, it } from "vitest";

import { buildServer } from "../../src/server.js";
import { serviceVersion } from "../../src/version.js";

const policy = "camera=(), microphone=(), geolocation=(), payment=()";

describe("Permissions-Policy (#746)", () => {
  it.each([
    { url: "/health", status: 200 },
    { url: "/does-not-exist", status: 404 },
    { url: "/validate?count=no", status: 400 },
    { url: "/health?count=1&count=2", status: 400 },
    { url: "/limited", status: 429 },
    { url: "/docs", status: 200 },
    { url: "/docs/json", status: 200 },
    { url: "/docs/static/swagger-ui.css", status: 200 },
  ])("sets one policy on $url ($status)", async ({ url, status }) => {
    const app = await buildServer({ rateLimitMax: 1 });
    app.get("/validate", {
      schema: { querystring: {
        type: "object",
        properties: { count: { type: "integer" } },
      } },
    }, async () => ({ ok: true }));
    app.get("/limited", async () => ({ ok: true }));

    try {
      if (status === 429) {
        const first = await app.inject({ url });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ ok: true });
      }
      const response = await app.inject({ url, headers: { "x-request-id": "policy-test" } });
      expect(response.statusCode).toBe(status);
      if (url === "/health") {
        expect(response.json()).toEqual({ status: "ok", version: serviceVersion });
      } else if (status >= 400) {
        expect(response.json()).toEqual({
          code: status === 404 ? "NOT_FOUND" : status === 429 ? "RATE_LIMITED" : "VALIDATION_ERROR",
          error: status === 404 ? "Route GET /does-not-exist not found"
            : status === 429 ? "rate limit exceeded"
            : url.startsWith("/validate") ? "querystring/count must be integer"
            : "repeated query parameter: count",
          requestId: "policy-test",
        });
      } else if (url === "/docs") {
        expect(response.headers["content-type"]).toContain("text/html");
        expect(response.body).toContain("/docs/static/swagger-ui-bundle.js");
      }
      // Early onRequest rejections already bypass Helmet and the request-id
      // hook. Keep their existing behavior while requiring the new policy.
      if (url !== "/health?count=1&count=2" && status !== 429) {
        expect(response.headers["x-request-id"]).toBe("policy-test");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
        expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
        expect(response.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
      } else {
        expect(response.headers["x-request-id"]).toBeUndefined();
        expect(response.headers["content-security-policy"]).toBeUndefined();
        expect(response.headers["referrer-policy"]).toBeUndefined();
        expect(response.headers["x-content-type-options"]).toBeUndefined();
        expect(response.headers["cross-origin-resource-policy"]).toBeUndefined();
      }
      expect(response.headers["permissions-policy"]).toBe(policy);
      // An array or comma-joined duplicate would fail this exact string check.
      expect(response.raw.res.getHeader("permissions-policy")).toBe(policy);
    } finally {
      await app.close();
    }
  });
});
