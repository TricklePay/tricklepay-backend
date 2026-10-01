// Registers the GET /status endpoint.
// This route reads the latest indexer position and error counts from the database.

import type { FastifyInstance } from "fastify";

import { countFailedEvents } from "../repositories/failed-events.js";

import { getIndexerPosition } from "../repositories/indexer-state.js";

import { INDEXER_STATUS_SCHEMA_ID, indexerStatusSchema } from "../schema.js";

// The default TTL for the server-side status cache. Kept short (2 s) so

// monitoring tools get a reasonably fresh view without hammering the database
// on every poll. The value is exported so tests can pass a custom TTL and
// exercise expiry without sleeping for the production window.
export const STATUS_CACHE_TTL_MS = 2_000;

// The number of ledgers the indexer may fall behind the chain head and
// still be considered ready. A freshly started instance that has never polled
// (or has only just begun) is not ready, because it cannot yet serve usable
// data. The value is exported so tests can override it.
export const READYNESS_MAX_LAG_LEDGERS = 50;

type StatusPayload = {
  indexer: {
    initialized: boolean;
    startLedger: number;
    lastLedger: number;
    cursor: string | null;
    updatedAt: string | null;
  };
  chain: { latestLedger: number };
  lagLedgers: number | null;
  failedEventCount: number;
};

// Simple in-process TTL cache: one slot, refreshed whenever the entry is older
// than `ttlM`'. Extracted as a factory so each plugin registration gets its own
// independent cache, which keeps tests isolated from one another.
function makeStatusCache(ttlMs: number) {
  let cachedAt = -Infinity;
  let cached: StatusPayload | null = null;

  return {
    get(now: number): StatusPayload | null {
      return now - cachedAt < ttlMs ? cached : null;
    },
    set(payload: StatusPayload, now: number): void {
      cached = payload;
      cachedAt = now;
    },
  };
}

export type StatusRoutesOptions = {
  /** Override the cache TTL (milliseconds). Defaults to STATUS_CACHE_TTL_MS. */
  cacheTtlMs?: number;
/** Configured ledger from which indexing begins when there is no saved cursor. */
  startLedger?: number;
  /** Override the readiness lag threshold (ledgers). */
  readinessMaxLagLedgers?: number;
};

// Reports how far the indexer has progressed, so an operator or monitor can see
// whether it is keeping up with the chain. The indexer's position and the
// chain's head are reported separately, because only the distance between them
// says anything about lag: a single figure near the head could mean either that
// there is nothing to catch up on or that the wrong number is being reported.
//
// Both come from Postgres, as everything this API serves does, so they are as
// of the indexer's last completed poll. `updatedAt` is when that was: an
// indexer that has stopped leaves a lag that no longer grows, and this is what
// tells that apart from one that is genuinely level.
//
// Readiness (`/ready`) reflects whether the indexer has made progress: an
// instance that has never polled, or that is more than `readinessMaxLagLedgers`
// behind the chain head, is not ready. Liveness (`/healthz`) is unaffected and
// continues to report the process as alive.
export async function statusRoutes(
  app: FastifyInstance,
  opts: StatusRoutesOptions = {},
): Promise<void> {
  const ttlMs = opts.cacheTtlMs ?? STATUS_CACHE_TTL_MS;
const startLedger = opts.startLedger ?? 0;
  const maxLagLedgers = opts.readinessMaxLagLedgers ?? READINESS_MAX_LAG_LEDGERS;
  const cache = makeStatusCache(ttlMs);

  if (!app.getSchema(INDEXER_STATUS_SCHEMA_ID)) app.addSchema(indexerStatusSchema);

  app.get(
    "/status",
    {
      schema: {
        summary: "Report indexer progress",
        description:
          "Reports the configured start ledger alongside the indexer's current position, chain head, and lag.",
        tags: ["indexer"],
        response: {
          200: { $ref: INDEXER_STATUS_SCHEMA_ID },
        },
      },
},
    async (_request, reply) => {
      const now = Date.now();
      const hit = cache.get(now);
      if (hit !== null) {
        reply.header("Cache-Control", "no-store");
        return hit;
      }

      const position = await getIndexerPosition();
      const failedEventCount = await countFailedEvents();

      const payload: StatusPayload = {
        indexer: {
          initialized: position !== null,
          startLedger,
          lastLedger: position?.lastLedger ?? 0,
          cursor: position?.cursor ?? null,
          updatedAt: position?.updatedAt.toISOString() ?? null,
        },
        chain: {
          latestLedger: position?.chainLedger ?? 0,
        },
        // Ledgers behind the chain, or null before the first poll has recorded
        // anything to measure against. Never negative: the head is read in the
        // same poll that applies the events, so the position cannot outrun it.
        lagLedgers: position ? Math.max(0, position.chainLedger - position.lastLedger) : null,
        failedEventCount,
      };

      cache.set(payload, now);
      reply.header("Cache-Control", "no-store");
      return payload;
    },
  );
}

  // Readiness check. Unlike `/status`, this is not cached: a container orchestrator
// polls it to decide whether to send traffic to this instance, and a stale
// cached answer would let it route to an instance that cannot yet serve data.
  app.get("/ready", async (_request, reply) => {
    const position = await getIndexerPosition();

    // No recorded position means the indexer has never completed a poll, so the
    // service has no usable data yet and must not be marked ready.
    if (position === null) {
      reply.code(503);
      return { ready: false, reason: "indexer-not-initialized" };
    }

    const lagLedgers = Math.max(0, position.chainLedger - position.lastLedger);
    if (lagLedgers > maxLagLedgers) {
      reply.code(503);
      return {
        ready: false,
        reason: "indexer-behind",
        lagLedgers,
        maxLagLedgers,
      };
    }

    return { ready: true, lagLedgers, maxLagLedgers };
  });
}
