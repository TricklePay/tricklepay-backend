import type { FastifyInstance } from "fastify";
import { getIndexerPosition } from "../repositories/indexer-state.js";
import { indexerStatusSchema, INDEXER_STATUS_SCHEMA_ID } from "../schema.js";

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
  // Register the shared schema if not already present (e.g. in test contexts
  // where a bare Fastify instance is used without buildServer).
  if (!app.getSchema(INDEXER_STATUS_SCHEMA_ID)) app.addSchema(indexerStatusSchema);

  app.get(
    "/status",
    {
      schema: {
        summary: "Indexer status",
        description:
          "Returns the indexer's current position relative to the chain head. " +
          "lagLedgers is the gap between the two; null before the first poll completes.",
        tags: ["indexer"],
        response: {
          200: { $ref: INDEXER_STATUS_SCHEMA_ID },
        },
      },
    },
    async () => {
      const position = await getIndexerPosition();

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
      };
    },
  );
}
