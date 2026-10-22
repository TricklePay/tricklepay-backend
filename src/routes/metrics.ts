// Registers the GET /metrics endpoint.
// This route serves in-memory Prometheus metrics and does not read from the database.

import type { FastifyInstance } from "fastify";

import { createHash, timingSafeEqual } from "node:crypto";

import { renderMetrics } from "../metrics.js";

// Serves all registered Prometheus metrics in the standard text exposition
// format (text/plain; version=0.0.4). Scrape this endpoint from a Prometheus
// instance or a compatible collector (Grafana Alloy, Victoria Metrics, etc.).
//
// Authentication is optional (#522). When a token is configured, requests must
// send `Authorization: Bearer <token>`; without one the endpoint is
// unauthenticated, exactly as before. The token is an extra layer on top of the
// recommended network restriction, not a replacement for it.

export interface MetricsOptions {
  /** Shared secret required on /metrics. Unset keeps the endpoint open. */
  token?: string;
}

// Compares two secrets in constant time. Both inputs are hashed to a fixed
// 32-byte digest first so the comparison never short-circuits on a length
// difference (timingSafeEqual throws on unequal buffer lengths, and comparing
// raw strings with `===` leaks a timing signal).
export function tokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export async function metricsRoutes(
  app: FastifyInstance,
  opts: MetricsOptions,
): Promise<void> {
  const token = opts?.token;

  app.get("/metrics", async (request, reply) => {
    if (token) {
      const header = request.headers.authorization;
      const match = typeof header === "string"
        ? /^Bearer\s+(.+)$/i.exec(header)
        : null;

      if (!match || !tokenMatches(match[1], token)) {
        // Same answer for missing, malformed, and wrong tokens so a caller
        // cannot use the response to probe the secret.
        return reply
          .code(401)
          .header("WWW-Authenticate", 'Bearer realm="metrics"')
          .send({
            code: "REQUEST_ERROR",
            error: "unauthorized",
            requestId: request.id,
          });
      }
    }

    const body = renderMetrics();
    return reply
      .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(body);
  });
}
