import Fastify from "fastify";
import { describe, expect, it } from "vitest";

// The metrics endpoint is the only observable output of the metrics module for
// operators and monitoring systems, so the tests verify: the correct Content-Type,
// the presence of each declared series, and that counters and gauges render
// valid Prometheus exposition lines.
//
// The metrics module is a singleton registry — whatever other tests have
// incremented will also be present here. The assertions therefore check for the
// presence of expected lines rather than exact values, which keeps the tests
// independent of execution order.

const { metricsRoutes } = await import("../../src/routes/metrics.js");

async function getMetrics() {
  const app = Fastify({ logger: false });
  await app.register(metricsRoutes);
  const response = await app.inject({ method: "GET", url: "/metrics" });
  await app.close();
  return response;
}

describe("GET /metrics", () => {
  it("responds with 200 and Prometheus content type", async () => {
    const response = await getMetrics();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["content-type"]).toContain("version=0.0.4");
  });

  it("includes the indexer lag gauge", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_indexer_lag_ledgers");
    expect(body).toContain("# TYPE tricklepay_indexer_lag_ledgers gauge");
    expect(body).toMatch(/tricklepay_indexer_lag_ledgers \d+/);
  });

  it("includes the events applied counter", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_indexer_events_applied");
    expect(body).toContain("# TYPE tricklepay_indexer_events_applied counter");
  });

  it("includes the pages fetched counter", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_indexer_pages_fetched");
    expect(body).toContain("# TYPE tricklepay_indexer_pages_fetched counter");
  });

  it("includes the RPC errors counter", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_rpc_errors");
    expect(body).toContain("# TYPE tricklepay_rpc_errors counter");
  });

  it("includes the poll errors counter", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_indexer_poll_errors");
    expect(body).toContain("# TYPE tricklepay_indexer_poll_errors counter");
  });

  it("includes HTTP request duration histogram", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_http_request_duration_ms");
    expect(body).toContain("# TYPE tricklepay_http_request_duration_ms histogram");
    // Each histogram must have _bucket, _sum, and _count lines.
    expect(body).toContain("tricklepay_http_request_duration_ms_bucket");
    expect(body).toContain("tricklepay_http_request_duration_ms_sum");
    expect(body).toContain("tricklepay_http_request_duration_ms_count");
  });

  it("includes HTTP requests total counter", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_http_requests_total");
    expect(body).toContain("# TYPE tricklepay_http_requests_total counter");
  });

  it("produces valid Prometheus text format — every non-comment line has a space-separated value", async () => {
    const body = (await getMetrics()).body;
    const lines = body.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"));
    for (const line of lines) {
      // A valid sample line is: metric_name[{labels}] value [timestamp]
      // The value must be a number or NaN/+Inf/-Inf.
      expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\{[^}]*\})? [-+]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\+Inf|-Inf|NaN)$/);
    }
  });

  it("records a /metrics hit in the HTTP requests counter after the hook fires", async () => {
    // Hitting /metrics through a server with the onResponse hook wired registers
    // the request itself. This test uses a server that has both the hook and the
    // route, mirroring production setup.
    const { buildServer } = await import("../../src/server.js");
    const app = await buildServer();
    await app.register(metricsRoutes);

    // First request: recorded by the hook.
    await app.inject({ method: "GET", url: "/metrics" });

    // Second request: the counter now includes the first hit.
    const response = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    expect(response.statusCode).toBe(200);
    // The /metrics route itself must appear at least once in the counter.
    expect(response.body).toMatch(/tricklepay_http_requests_total\{[^}]*route="\/metrics"/);
  });
});
