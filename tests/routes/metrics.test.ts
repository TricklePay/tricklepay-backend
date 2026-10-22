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

const { metricsRoutes, tokenMatches } = await import("../../src/routes/metrics.js");

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

  it("includes the poller heartbeat metrics", async () => {
    // Operators rely on these to tell a quiet chain from a stalled poller.
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_indexer_poll_success_total");
    expect(body).toContain("# TYPE tricklepay_indexer_poll_success_total counter");
    expect(body).toContain("# HELP tricklepay_indexer_poll_last_success_timestamp_seconds");
    expect(body).toContain(
      "# TYPE tricklepay_indexer_poll_last_success_timestamp_seconds gauge",
    );
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

  it("includes the database query duration histogram without labels", async () => {
    const body = (await getMetrics()).body;
    expect(body).toContain("# HELP tricklepay_database_query_duration_ms");
    expect(body).toContain("# TYPE tricklepay_database_query_duration_ms histogram");
    expect(body).toContain("tricklepay_database_query_duration_ms_bucket{le=");
    expect(body).toContain("tricklepay_database_query_duration_ms_count ");
    expect(body).not.toContain('tricklepay_database_query_duration_ms_count{');
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

  it("keeps metric label sets bounded by using route patterns instead of resolved paths", async () => {
    const { buildServer } = await import("../../src/server.js");
    const app = await buildServer();
    await app.register(metricsRoutes);
    
    // Register a parameterized route
    app.get("/test/:id", async () => "ok");

    // Hit the route with multiple distinct IDs
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "GET", url: `/test/distinct-id-${i}` });
    }

    const response = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    // The counter should record 5 hits under the single route pattern label
    const matches = response.body.match(/tricklepay_http_requests_total\{[^}]*route="\/test\/:id"/g) || [];
    expect(matches.length).toBe(1);
    expect(response.body).toMatch(/tricklepay_http_requests_total\{[^}]*route="\/test\/:id"[^}]*\}\s+5/);
    
    // Ensure raw paths do not leak into the metric labels
    expect(response.body).not.toContain("distinct-id");
  });
});

describe("Metrics bearer token (#522)", () => {
  const TOKEN = "test-metrics-token-123";

  async function requestMetrics(
    headers: Record<string, string> = {},
    token?: string,
  ) {
    const app = Fastify({ logger: false });
    await app.register(metricsRoutes, { token });
    const response = await app.inject({ method: "GET", url: "/metrics", headers });
    await app.close();
    return response;
  }

  it("keeps the endpoint unauthenticated when no token is configured", async () => {
    const response = await requestMetrics();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("returns 401 when a token is configured and no Authorization header is sent", async () => {
    const response = await requestMetrics({}, TOKEN);
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    expect(response.json()).toMatchObject({
      code: "REQUEST_ERROR",
      error: "unauthorized",
    });
  });

  it("returns 401 for a wrong token of the same length", async () => {
    const response = await requestMetrics(
      { authorization: `Bearer ${"x".repeat(TOKEN.length)}` },
      TOKEN,
    );
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for a wrong token of a different length", async () => {
    const response = await requestMetrics({ authorization: "Bearer short" }, TOKEN);
    expect(response.statusCode).toBe(401);
  });

  it("accepts the configured token", async () => {
    const response = await requestMetrics(
      { authorization: `Bearer ${TOKEN}` },
      TOKEN,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("# HELP tricklepay_indexer_lag_ledgers");
  });

  it("accepts the bearer scheme case-insensitively", async () => {
    const response = await requestMetrics(
      { authorization: `bearer ${TOKEN}` },
      TOKEN,
    );
    expect(response.statusCode).toBe(200);
  });

  it("never echoes the secret in a rejection", async () => {
    const response = await requestMetrics({ authorization: "Bearer nope" }, TOKEN);
    expect(response.body).not.toContain(TOKEN);
  });
});

describe("tokenMatches (#522)", () => {
  it("matches identical secrets", () => {
    expect(tokenMatches("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a different secret of equal length", () => {
    expect(tokenMatches("s3cret", "s3cr3t")).toBe(false);
  });

  it("rejects a prefix of the expected secret", () => {
    expect(tokenMatches("s3c", "s3cret")).toBe(false);
  });

  it("handles empty inputs without throwing", () => {
    expect(tokenMatches("", "")).toBe(true);
    expect(tokenMatches("", "s3cret")).toBe(false);
  });
});
