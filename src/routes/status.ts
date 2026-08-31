// Registers the GET /status endpoint.
// This route reads the latest indexer position and error counts from the database.

import type { FastifyInstance } from "fastify";

import { countFailedEvents } from "../repositories/failed-events.js";

import { getIndexerPosition } from "../repositories/indexer-state.js";

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
export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/status", async (_request, reply) => {
    const position = await getIndexerPosition();
    const failedEventCount = await countFailedEvents();

    reply.header("Cache-Control", "no-store");
    return {
      indexer: {
        initialized: position !== null,
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
  });
}
