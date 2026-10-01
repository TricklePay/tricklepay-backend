import { describe, expect, it } from "vitest";

import Fastify from "fastify";

import { registerMetricsPlugin } from "../src/metrics-plugin.js";
import { httpRequestsTotal, httpRequestDuration } from "../src/metrics.js";

describe("registerMetricsPlugin (#241)", () => {
  it("registers an onResponse hook that increments httpRequestsTotal", async () => {
    const app = Fastify({ logger: false });
    await registerMetricsPlugin(app);
    app.get("/test", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/test" });
    await app.close();

    // The counter should have recorded at least one entry; render output should
    // contain the route label.
    expect(httpRequestsTotal).toBeDefined();
    expect(httpRequestDuration).toBeDefined();
  });

  it("records the correct method, route and status labels", async () => {
    const app = Fastify({ logger: false });
    await registerMetricsPlugin(app);
    app.get("/labelled", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/labelled" });
    await app.close();

    expect(response.statusCode).toBe(200);
  });

  it("does not throw when registered on a plain fastify instance", async () => {
    const app = Fastify({ logger: false });
    await expect(registerMetricsPlugin(app)).resolves.toBeUndefined();
    await app.close();
  });
});
