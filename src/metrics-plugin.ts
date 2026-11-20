// ---------------------------------------------------------------------------
// Metrics plugin (#241).
//
// The onResponse hook that records Prometheus counters and histograms lives
// here as a registrable Fastify plugin. Extracting it lets callers register
// it explicitly, test it in isolation, and omit it in suites that do not
// need metrics.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";

import { httpRequestDuration, httpRequestsTotal } from "./metrics.js";

/**
 * Registers an onResponse hook that records HTTP request counts and durations
 * into the shared Prometheus registry after every response.
 *
 * Register during server construction:
 *   await registerMetricsPlugin(app);
 */
export async function registerMetricsPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("onResponse", async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions?.url ?? "unknown",
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime);
  });
}
