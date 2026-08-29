import type { FastifyInstance } from "fastify";

import { renderMetrics } from "../metrics.js";

// Serves all registered Prometheus metrics in the standard text exposition
// format (text/plain; version=0.0.4). Scrape this endpoint from a Prometheus
// instance or a compatible collector (Grafana Alloy, Victoria Metrics, etc.).
//
// No authentication is applied here; if the metrics endpoint should not be
// publicly reachable, restrict it at the network / ingress level.
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_request, reply) => {
    const body = renderMetrics();
    return reply
      .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(body);
  });
}
