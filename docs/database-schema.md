# Database Schema Overview

The TricklePay backend uses PostgreSQL managed via [Prisma](https://www.prisma.io). The schema defines four primary models that store on-chain stream states, raw event history, unapplied failure records, and indexer position markers.

## Tables and Models

### 1. `Stream`

Stores the current state of each token vesting stream as seen on-chain.

* **Purpose**: Serves read API queries (`/streams`, `/streams/:id`, `/streams/summary`) with current stream parameters and state. Derived metrics (vested, withdrawable, progress) are computed at request time using `startTime`, `endTime`, `cliffTime`, `totalAmount`, and `withdrawn`.
* **Fields**:
  * `streamId` (`BigInt`, Primary Key): On-chain unique stream identifier.
  * `sender` (`String`): Stellar account address of the stream creator / funder.
  * `recipient` (`String`): Stellar account address of the stream recipient.
  * `token` (`String`): Contract address / token identifier of the asset being streamed.
  * `totalAmount` (`Decimal(40, 0)`): Total token amount allocated to the stream (wide fixed-point decimal for 128-bit integer safety).
  * `withdrawn` (`Decimal(40, 0)`): Cumulative amount withdrawn by the recipient so far.
  * `startTime` (`BigInt`): Unix timestamp (seconds) when stream vesting begins.
  * `endTime` (`BigInt`): Unix timestamp (seconds) when stream vesting completes.
  * `cliffTime` (`BigInt`): Unix timestamp (seconds) before which no tokens vest or can be withdrawn.
  * `cancelled` (`Boolean`): Flag indicating if the stream was cancelled prior to completion.
  * `createdLedger` (`Int`): Ledger height in which the stream was created on-chain.
  * `updatedLedger` (`Int`): Ledger height of the most recent contract event applied to this stream.
  * `lastEventId` (`String?`): RPC `TOID-index` event ID of the last event applied to this stream. Used to ensure event application idempotency.
  * `createdAt` (`DateTime`): Database row creation timestamp.
  * `updatedAt` (`DateTime`): Database row last update timestamp.
* **Indexes**:
  * `[sender, streamId(sort: Desc)]` - Optimized querying for streams created by a sender.
  * `[recipient, streamId(sort: Desc)]` - Optimized querying for streams received by an address.
  * `[token, streamId(sort: Desc)]` - Optimized querying by token asset.

---

### 2. `IndexedEvent`

Append-only audit log of all decoded contract events emitted by the TricklePay stream smart contract.

#### What the table is for

`IndexedEvent` maintains a permanent, immutable audit log of every supported contract event (`created`, `withdrawn`, `cancelled`) observed on the Stellar blockchain. While the `Stream` table retains only the latest mutable state of each stream, `IndexedEvent` captures the complete historical timeline. It serves:
- **Auditability and Incident Review**: Enables operators and auditors to inspect historical contract actions, verify state transitions, and review transaction hashes and ledger numbers.
- **Stream History Inspection**: Powers the historical timeline API (`GET /streams/:id/events`), allowing users to inspect the lifecycle of a stream from creation to withdrawals and cancellation.
- **Replay and Reconciliation Verification**: Provides an immutable ledger against which current stream balances and state can be cross-checked during investigations.

#### What a single row represents

A single row represents a unique contract event emitted on-chain by the TricklePay smart contract during a Soroban transaction execution. It stores the event's unique chain-wide identifier, event classification, stream parameters, transferred amounts, and block context.

* **Fields**:
  * `eventId` (`String`, Primary Key): The Soroban RPC's `TOID-index` event identifier, unique per event on chain and ordered chronologically.
  * `kind` (`String`): Event kind, strictly matching one of the supported contract events: `"created"`, `"withdrawn"`, or `"cancelled"`.
  * `streamId` (`String`): The stream identifier associated with the event, stored as a string to avoid bigint serialization dependencies.
  * `ledger` (`Int`): Ledger sequence number in which the transaction emitting this event was closed.
  * `txHash` (`String`): Hex-encoded transaction hash containing the contract invocation.
  * `sender` (`String?`): Stellar account address of the stream creator; present on `created` events.
  * `recipient` (`String?`): Stellar account address of the stream recipient; present on `created` and `withdrawn` events.
  * `token` (`String?`): Contract address / token identifier of the asset being streamed; present on `created` events.
  * `totalAmount` (`Decimal(40, 0)?`): Initial stream deposit amount in smallest token units (e.g. stroops/base units, up to uint128); present on `created` events.
  * `amount` (`Decimal(40, 0)?`): Amount withdrawn in smallest token units; present on `withdrawn` events.
  * `recipientAmount` (`Decimal(40, 0)?`): Vested unwithdrawn balance paid to recipient upon cancellation in smallest token units; present on `cancelled` events.
  * `senderRefund` (`Decimal(40, 0)?`): Unvested deposit refunded to sender upon cancellation in smallest token units; present on `cancelled` events.
  * `startTime` (`BigInt?`): Stream start time as a Unix timestamp in seconds; present on `created` events.
  * `endTime` (`BigInt?`): Stream scheduled end time as a Unix timestamp in seconds; present on `created` events.
  * `cliffTime` (`BigInt?`): Stream cliff time as a Unix timestamp in seconds; present on `created` events.
  * `closedAt` (`BigInt?`): Ledger close time as a Unix timestamp in seconds when the event was emitted on-chain.
  * `createdAt` (`DateTime`): Database timestamp when the record was inserted (`@default(now())`).
  * `updatedAt` (`DateTime`): Database timestamp when the record was last updated (`@updatedAt`).
* **Indexes**:
  * `[streamId, ledger]` - Composite index enabling fast, ordered event timeline retrieval for a specific stream.
  * `[ledger]` - Index for querying events by ledger sequence height.

#### When a row is written

A row is written during the indexer's polling tick in `src/indexer/poller.ts` (`Poller.applyPage`).

1. **Extraction and Decoding**: When the indexer poller fetches a page of events from the Soroban RPC via `getContractEvents`, each raw event is decoded into a typed `StreamEvent` via `decodeEvent(raw)`.
2. **Persistence Path**: Immediately after successful decoding and before applying the event to the `Stream` table, the poller invokes:
   ```ts
   await recordIndexedEvent(indexedEventFromDecoded(event));
   ```
   This calls `recordIndexedEvent` in `src/repositories/indexed-events.ts`, which executes:
   ```ts
   await tx.indexedEvent.createMany({
     data: [...],
     skipDuplicates: true,
   });
   ```
3. **Idempotency**: Inserting with `skipDuplicates: true` keyed by `eventId` guarantees that re-polling or replaying pages that were already processed will not fail with unique constraint violations or duplicate audit entries.
4. **Resilience**: If writing to `IndexedEvent` encounters a database error, the failure is caught and logged as a warning (`could not persist indexed-event record`) so that an audit log issue does not abort or block the primary stream state mutation.
5. **Query Path**: Stored rows are queried through `listIndexedEvents(streamId)` in `src/repositories/indexed-events.ts` to power the `GET /streams/:id/events` route defined in `src/routes/streams.ts`.

---

### 3. `FailedEvent`

Records contract events that the indexer failed to process or apply to PostgreSQL.

* **Purpose**: Allows indexer operations to continue without dropping malformed or unprocessable events, giving operators a dedicated table to inspect and retry via `npm run replay-failed-events`.
* **Fields**:
  * `eventId` (`String`, Primary Key): Soroban RPC `TOID-index` event ID.
  * `kind` (`String`): Event type (`Created`, `Withdrawn`, `Cancelled`, or `"unknown"`).
  * `streamId` (`String?`): Associated stream identifier if decodable.
  * `ledger` (`Int`): Ledger height of the failing event.
  * `error` (`String`): Error description / exception message from the last failed attempt.
  * `failureCount` (`Int`): Number of times processing this event has been attempted and failed.
  * `firstFailedAt` (`DateTime`): Timestamp when the first failure occurred.
  * `lastFailedAt` (`DateTime`): Timestamp when the event was last retried.
* **Indexes**:
  * `[ledger]` - Querying failed events by block height.

#### What gets recorded on a failed apply

A failed event is written as a single `FailedEvent` row as soon as the poller catches an exception while decoding or applying the event. The row includes the event identifier, ledger, decoded kind, stream id when it could be recovered, and the most recent failure message. If the same event fails again, the row is updated in place to increment `failureCount` and refresh `error`, rather than creating a duplicate record. When the event later applies successfully, the replay flow clears the row.

#### How to inspect failed events

```sql
SELECT "eventId", "kind", "streamId", "ledger", "failureCount", "error"
FROM "FailedEvent"
ORDER BY "ledger" ASC, "eventId" ASC
LIMIT 20;

SELECT COUNT(*) FROM "FailedEvent";
```

This shows the oldest unresolved events first, along with the last error message for each row. Operators can pair this with `npm run replay-failed-events -- --dry-run --limit 20` to preview the next retry batch before mutating state.

#### What happens to the cursor when an event fails

The indexer does not rewind the cursor when a single event fails. It catches the error, records the failed row, and moves on to the next event in the same page. The cursor is only persisted after the page completes and `saveIndexerPosition` runs, so the next poll resumes from the advanced page cursor instead of replaying the bad event. `lastLedger` also advances only after a successful apply, which means a failed event is skipped rather than counted as processed.

---

### 4. `IndexerState`

Single-row bookkeeping table tracking indexer progress and chain sync status.

* **Purpose**: Persists the indexer's latest position across service restarts and enables lag calculation (`chainLedger - lastLedger`).
* **Fields**:
  * `id` (`String`, Primary Key): Fixed identifier string (e.g. `"default"`).
  * `lastLedger` (`Int`): Highest ledger height whose events have been successfully applied to the database.
  * `chainLedger` (`Int`): Latest ledger height of the Stellar network during the last poll tick.
  * `cursor` (`String?`): Soroban RPC pagination token used to fetch the next page of contract events.
  * `updatedAt` (`DateTime`): Timestamp of the last poll or state update.

---

## Entity Relationships and Data Flow

```
                     +-------------------+
                     |   Stellar RPC     |
                     +---------+---------+
                               |
                        fetches events
                               |
                               v
                     +-------------------+
                     |   IndexerState    |
                     | (lastLedger,      |
                     |  cursor)          |
                     +---------+---------+
                               |
                               v
             +-----------------+-----------------+
             |                                   |
    on success apply                     on failure record
             |                                   |
             v                                   v
  +------------------+                  +------------------+
  |   IndexedEvent   |                  |   FailedEvent    |
  |  (event log)     |                  | (retried via CLI)|
  +--------+---------+                  +------------------+
           |
   updates stream state
           |
           v
  +------------------+
  |      Stream      |
  |  (current state) |
  +------------------+
```

1. **`IndexerState` to Soroban RPC**: The poller reads `IndexerState.cursor` to request event pages from Soroban RPC.
2. **`IndexedEvent` to `Stream`**: Each successful event is stored in `IndexedEvent` and updates the target `Stream` row state. `Stream.lastEventId` stores `IndexedEvent.eventId` so that duplicate events in a page re-read are ignored (idempotency).
3. **`Stream` to `FailedEvent`**: If an event fails during decoding or DB application, a row is upserted into `FailedEvent`. Successful retry via `replay-failed-events` applies the change to `Stream` and deletes the `FailedEvent` entry.
