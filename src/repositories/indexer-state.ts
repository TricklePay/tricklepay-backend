// Repository module for indexer checkpoint and synchronization state.
//
// Manages database persistence and retrieval of the indexer's sync progress,
// tracking the last processed ledger, chain head ledger, RPC resumption
// cursor, and update timestamp for the contract stream tracker.
//
// Direct database access is confined to this repository layer: all reads and
// writes to the indexer_state table in PostgreSQL must flow through these
// functions rather than calling the database client directly.

import { prisma } from "../db.js";

// Fixed key for the single indexer-state row. There is one indexed contract, so
// one row of bookkeeping.
const STATE_ID = "stream";

// Where the indexer has got to. `lastLedger` is its own progress and
// `chainLedger` the chain's, kept apart so the gap between them is visible;
// `cursor` is the RPC paging token to resume from.
export interface IndexerPosition {
  lastLedger: number;
  chainLedger: number;
  cursor: string | null;
}

export interface StoredPosition extends IndexerPosition {
  // When the position was last written. A position that has stopped moving is
  // indistinguishable from a quiet contract without this.
  updatedAt: Date;
}

export async function getIndexerPosition(): Promise<StoredPosition | null> {
  const state = await prisma.indexerState.findUnique({ where: { id: STATE_ID } });
  if (!state) return null;
  return {
    lastLedger: state.lastLedger,
    chainLedger: state.chainLedger,
    cursor: state.cursor,
    updatedAt: state.updatedAt,
  };
}

// Writes the position reached by a completed poll. `lastLedger` is expected to
// move forward only; the caller carries it across ticks and raises it as events
// are applied, so a poll that applied nothing leaves it where it was.
export async function saveIndexerPosition(position: IndexerPosition): Promise<void> {
  await prisma.indexerState.upsert({
    where: { id: STATE_ID },
    create: { id: STATE_ID, ...position },
    update: position,
  });
}
