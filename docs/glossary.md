# Glossary of Indexer Terms

This glossary defines core domain and indexer terms used across the `tricklepay-backend` codebase and documentation. Each definition reflects the precise technical meaning implemented in the source code.

---

### Term Definitions

#### **Cursor**
The opaque pagination token returned by Soroban RPC `getEvents` calls (stored in `IndexerState.cursor`). 
- **Codebase Meaning**: The RPC cursor marks how far the indexer has scanned through Soroban event logs. It advances on every poll tick—even on quiet ledgers where no relevant contract events occur. 
- **Key Difference**: Unlike `lastLedger`, the `cursor` represents scan progress rather than applied data progress and is not used to calculate indexer lag.

#### **Ledger**
A block on the Stellar network containing transactions and emitted contract events, identified by a sequential 32-bit integer height.
- **Codebase Meaning**: Refers to specific block heights recorded in database columns such as `Stream.createdLedger`, `Stream.updatedLedger`, `IndexedEvent.ledger`, `FailedEvent.ledger`, `IndexerState.lastLedger`, and `IndexerState.chainLedger`.

#### **Backfill**
The operation where the indexer catches up by polling and processing historical contract events from an earlier ledger height (`INDEXER_START_LEDGER`) up to the current chain head.
- **Codebase Meaning**: During a backfill, event processing writes raw events to PostgreSQL without requiring on-chain RPC simulations, allowing the indexer to process historical streams rapidly.

#### **Lag**
The numerical gap in ledgers between the current height of the Stellar network and the indexer's applied progress (`chainLedger - lastLedger`).
- **Codebase Meaning**: Lag measures how many ledgers behind the chain the indexer currently is. It is derived exclusively from `lastLedger` (which moves only when events are applied) rather than `cursor` (which advances on every poll tick regardless of whether events were found).

#### **Applied Event**
A contract event (`Created`, `Withdrawn`, or `Cancelled`) fetched from Soroban RPC whose state modifications have been successfully persisted to the PostgreSQL database.
- **Codebase Meaning**: Applying an event updates the matching `Stream` row, creates an `IndexedEvent` log entry, updates `Stream.lastEventId`, and advances `IndexerState.lastLedger`. Applying an event is idempotent: replaying an already-applied event produces no side effects.

---

### Supporting Technical Terms

* **`TOID-index`**: The compound event identifier format (`ledger-tx-index`) returned by Soroban RPC `getEvents`, stored in `IndexedEvent.eventId`, `FailedEvent.eventId`, and `Stream.lastEventId`. Used for lexicographical ordering and idempotent event filtering.
* **Delta**: A contract event payload (`Withdrawn` or `Cancelled`) that modifies an existing stream's state rather than creating a new stream (`Created`).
* **Poll Tick**: A single execution loop of `poller.ts` which fetches up to `INDEXER_MAX_PAGES_PER_TICK` pages from Soroban RPC, processes them, and persists `IndexerState`.
* **Replay**: Re-executing event processing for event pages or rows in `FailedEvent` via `npm run replay-failed-events`.
