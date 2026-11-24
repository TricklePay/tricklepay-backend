// Hook that adds the X-Indexer-Lag-Ledgers header to read responses.
//
// The indexer lag is the number of ledgers between the indexer's last
// processed ledger and the chain's latest ledger. This header lets clients
// know how fresh the data is without making a separate /status request.
//
// The header is only added to successful GET requests (read operations),
// is omitted on errors (>= 400) and 304 Not Modified responses, and is
// omitted before the first poll when no position has been recorded yet.

import type { FastifyInstance } from "fastify";

import { getIndexerPosition } from "./repositories/indexer-state.js";

// Cache the lag value briefly to avoid hitting the database on every request.
// The lag changes slowly (once per indexer poll), so a short TTL keeps the
// overhead minimal while still providing useful information.
const CACHE_TTL_MS = 2_000;

let cachedLag: number | null = null;
let cachedAt = -Infinity;

export function resetLagCache(): void {
  cachedLag = null;
  cachedAt = -Infinity;
}

async function getLag(): Promise<number | null> {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) {
    return cachedLag;
  }

  const position = await getIndexerPosition();
  if (!position) {
    cachedLag = null;
    cachedAt = now;
    return null;
  }

  const lag = Math.max(0, position.chainLedger - position.lastLedger);
  cachedLag = lag;
  cachedAt = now;
  return lag;
}

const EXCLUDED_PATHS = new Set(["/health", "/ready", "/metrics"]);

export function registerIndexerLagHook(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply) => {
    // Only add the header to GET requests (read operations)
    if (request.method !== "GET") return;

    // Skip error responses and 304 Not Modified responses
    if (reply.statusCode >= 400 || reply.statusCode === 304) {
      return;
    }

    // Skip health check and metrics endpoints (comparing path without query string)
    const urlPath = request.url.split("?")[0];
    if (EXCLUDED_PATHS.has(urlPath)) {
      return;
    }

    try {
      const lag = await getLag();
      if (lag !== null) {
        reply.header("X-Indexer-Lag-Ledgers", lag.toString());
      }
    } catch (err) {
      request.log.debug({ err }, "could not read indexer lag");
    }
  });
}
