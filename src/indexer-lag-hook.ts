// Hook that adds the X-Indexer-Lag-Ledgers and X-Data-Stale headers to read responses.
//
// The indexer lag is the number of ledgers between the indexer's last
// processed ledger and the chain's latest ledger. This header lets clients
// know how fresh the data is without making a separate /status request.
//
// X-Data-Stale is a boolean header (true only) that indicates when the lag
// exceeds a configured threshold, allowing simple clients to show a warning
// without parsing the lag number. The threshold reuses the readiness staleness
// setting (READY_MAX_STALENESS_MS) converted to ledgers.
//
// The headers are only added to successful GET requests (read operations),
// are omitted on errors (>= 400) and 304 Not Modified responses, and are
// omitted before the first poll when no position has been recorded yet.

import type { FastifyInstance } from "fastify";

import { getIndexerPosition } from "./repositories/indexer-state.js";

// Cache the lag value briefly to avoid hitting the database on every request.
// The lag changes slowly (once per indexer poll), so a short TTL keeps the
// overhead minimal while still providing useful information.
const CACHE_TTL_MS = 2_000;

// Approximate ledger close time in milliseconds. Stellar ledgers close roughly
// every 5 seconds, so this is used to convert the time-based staleness threshold
// to a ledger-based threshold for the stale data indicator.
const LEDGER_CLOSE_TIME_MS = 5_000;

const EXCLUDED_PATHS = new Set(["/health", "/ready", "/metrics"]);

export interface IndexerLagHookOptions {
  /** Maximum staleness in milliseconds before data is considered stale. 0 = disabled. */
  stalenessThresholdMs?: number;
}

export function registerIndexerLagHook(
  app: FastifyInstance,
  opts: IndexerLagHookOptions = {},
): void {
  const stalenessThresholdMs = opts.stalenessThresholdMs ?? 0;
  const stalenessThresholdLedgers =
    stalenessThresholdMs > 0
      ? Math.ceil(stalenessThresholdMs / LEDGER_CLOSE_TIME_MS)
      : 0;

  let cachedLag: number | null = null;
  let cachedAt = -Infinity;

  async function getLag(): Promise<number | null> {
    const now = Date.now();
    if (now - cachedAt < CACHE_TTL_MS) return cachedLag;

    const position = await getIndexerPosition();
    cachedLag = position ? Math.max(0, position.chainLedger - position.lastLedger) : null;
    cachedAt = now;
    return cachedLag;
  }

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

        // Add X-Data-Stale header when lag exceeds the threshold
        if (stalenessThresholdLedgers > 0 && lag >= stalenessThresholdLedgers) {
          reply.header("X-Data-Stale", "true");
        }
      }
    } catch (err) {
      request.log.debug({ err }, "could not read indexer lag");
    }
  });
}
