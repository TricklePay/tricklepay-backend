import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("CORS origin handling", () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN;

  afterEach(async () => {
    if (originalCorsOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = originalCorsOrigin;
    }
  });

  it("reflects the request origin when CORS_ORIGIN is unset", async () => {
    delete process.env.CORS_ORIGIN;

    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { Origin: "https://app.example.com" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
  });

  it("allows only the pinned origin when CORS_ORIGIN is set", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";

    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { Origin: "https://app.example.com" },
    });
    await app.close();

    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
  });

  it("rejects mismatched origins when CORS_ORIGIN is pinned", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";

    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { Origin: "https://evil.example.com" },
    });
    await app.close();

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("disables CORS when CORS_ORIGIN is empty", async () => {
    process.env.CORS_ORIGIN = "";

    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { Origin: "https://app.example.com" },
    });
    await app.close();

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight OPTIONS requests with the expected CORS headers", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";

    const app = await buildServer();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/streams",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    await app.close();

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
    expect(response.headers["access-control-allow-methods"]).toContain("GET");
    expect(response.headers["access-control-allow-headers"]).toBeTruthy();
  });
});
