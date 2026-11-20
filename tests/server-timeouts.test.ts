import { afterEach, describe, it, expect, vi } from "vitest";
import { prisma } from "../src/db.js";
import { streamRoutes } from "../src/routes/streams.js";
import { buildServer } from "../src/server.js";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../src/config.js";

describe("Server timeouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
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

    // Register a route that delays longer than the timeout
    app.get("/slow", async (_request, reply) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return reply.send({ ok: true });
    });

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/slow",
    });

    // Fastify terminates with 503 or 408 on request timeout
    expect([408, 503]).toContain(response.statusCode);

    await app.close();
  });

  it("cancels running handler and asserts a single 408 and no error log with a never-resolving query (#675)", async () => {
    const app = await buildServer({
      requestTimeoutMs: 50,
    });

    const errorSpy = vi.spyOn(app.log, "error");
    const warnSpy = vi.spyOn(app.log, "warn");

    // Mock a database query that never resolves
    vi.spyOn(prisma.stream, "findUnique").mockImplementation(
      () => new Promise(() => {}) as never,
    );

    await app.register(streamRoutes);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/streams/42",
    });

    expect(response.statusCode).toBe(408);
    expect(response.json().code).toBe("REQUEST_ERROR");
    expect(response.json().error).toBe("request timeout");

    // Allow any raced callbacks / promises to settle
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Assert no duplicate-send warning or unhandled error log was produced
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    await app.close();
  });
});
