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

Stores raw decoded contract events (`Created`, `Withdrawn`, `Cancelled`) emitted by the Soroban contract.

* **Purpose**: Maintains an immutable log of processed events for auditing, replay verification, and transaction history.
* **Fields**:
  * `eventId` (`String`, Primary Key): Soroban RPC `TOID-index` event ID, unique across the chain.
  * `kind` (`String`): Event type (`Created`, `Withdrawn`, `Cancelled`).
  * `streamId` (`String`): Target stream identifier associated with the event.
  * `ledger` (`Int`): Ledger height where the event occurred.
  * `txHash` (`String`): Stellar transaction hash containing the event.
  * `sender`, `recipient`, `token` (`String?`): Associated addresses present in `Created` events.
  * `totalAmount`, `amount`, `recipientAmount`, `senderRefund` (`Decimal(40, 0)?`): Event amount payloads.
  * `startTime`, `endTime`, `cliffTime`, `closedAt` (`BigInt?`): Timestamps present in event payloads.
  * `createdAt`, `updatedAt` (`DateTime`): Timestamps for record lifecycle.
* **Indexes**:
  * `[streamId, ledger]` - Fast lookup of events for a specific stream.
  * `[ledger]` - Fast lookup of events by ledger height.

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
