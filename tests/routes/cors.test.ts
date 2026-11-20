import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

describe("CORS headers", () => {
  it("exposes custom response headers when Origin header is present", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://example.com",
      },
    });

    expect(response.statusCode).toBe(200);
    const exposed = response.headers["access-control-expose-headers"];
    expect(exposed).toBeDefined();

    const expectedHeaders = [
      "ETag",
      "Retry-After",
      "X-Request-Id",
      "Link",
      "X-Indexer-Lag-Ledgers",
    ];

    for (const header of expectedHeaders) {
      expect(exposed?.toString().toLowerCase()).toContain(header.toLowerCase());
    }

    await app.close();
  });
});
