import type { FastifyInstance } from "fastify";
import { getIndexerPosition } from "../repositories/indexer-state.js";

// Reports how far the indexer has progressed, so an operator or monitor can see
// whether it is keeping up with the chain.
export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/status", async () => {
    const position = await getIndexerPosition();
    return {
      indexer: {
        initialized: position !== null,
        lastLedger: position?.lastLedger ?? 0,
        cursor: position?.cursor ?? null,
      },
    };
  });
}
