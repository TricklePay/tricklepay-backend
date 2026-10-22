import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../src/config.js";

describe("Server timeouts", () => {
  it("applies default timeouts when not configured", async () => {
    const app = await buildServer({});

    expect(app.server.timeout).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(app.server.keepAliveTimeout).toBe(DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
    expect(app.server.requestTimeout).toBe(DEFAULT_REQUEST_TIMEOUT_MS);

    await app.close();
  });

  it("applies explicit timeout configuration", async () => {
    const app = await buildServer({
      connectionTimeoutMs: 15000,
      keepAliveTimeoutMs: 60000,
      requestTimeoutMs: 20000,
    });

    expect(app.server.timeout).toBe(15000);
    expect(app.server.keepAliveTimeout).toBe(60000);
    expect(app.server.requestTimeout).toBe(20000);

    await app.close();
  });

  it("closes stalled requests after requestTimeout", async () => {
    const app = await buildServer({
      requestTimeoutMs: 100,
    });

    await app.ready();

    // Register a route that delays longer than the timeout
    app.get("/slow", async (_request, reply) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return reply.send({ ok: true });
    });

    const response = await app.inject({
      method: "GET",
      url: "/slow",
    });

    // Fastify terminates with 503 or 408 on request timeout
    expect([408, 503]).toContain(response.statusCode);

    await app.close();
  });
});
