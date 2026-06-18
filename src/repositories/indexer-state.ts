import { prisma } from "../db.js";

// Fixed key for the single indexer-state row. There is one indexed contract, so
// one row of bookkeeping.
const STATE_ID = "stream";

export interface IndexerCursor {
  lastLedger: number;
  cursor: string | null;
}

export async function getIndexerCursor(): Promise<IndexerCursor | null> {
  const state = await prisma.indexerState.findUnique({ where: { id: STATE_ID } });
  if (!state) return null;
  return { lastLedger: state.lastLedger, cursor: state.cursor };
}

export async function saveIndexerCursor(lastLedger: number, cursor: string | null): Promise<void> {
  await prisma.indexerState.upsert({
    where: { id: STATE_ID },
    create: { id: STATE_ID, lastLedger, cursor },
    update: { lastLedger, cursor },
  });
}
