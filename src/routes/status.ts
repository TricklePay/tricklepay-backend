import type { FastifyInstance } from "fastify";
import { getIndexerCursor } from "../repositories/indexer-state.js";

// Reports how far the indexer has progressed, so an operator or monitor can see
// whether it is keeping up with the chain.
export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/status", async () => {
    const cursor = await getIndexerCursor();
    return {
      indexer: {
        initialized: cursor !== null,
        lastLedger: cursor?.lastLedger ?? 0,
        cursor: cursor?.cursor ?? null,
      },
    };
  });
}
