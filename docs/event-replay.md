# Event Replay Guide

The event replay command (`src/indexer/replay.ts`) is an operator recovery tool used to reprocess contract events that failed to decode or apply during indexer operation.

## What It Does

When the indexer encounters an event that cannot be decoded or applied to PostgreSQL, it records a row in the `FailedEvent` table and advances the cursor so the rest of the stream is not blocked.

The replay tool provides a targeted, out-of-band mechanism to retry those failed events:

1. **Loads Unresolved Failures**: Reads the oldest unresolved records from the `FailedEvent` table (`listFailedEvents`), ordered by `ledger ASC, eventId ASC` up to the configured batch limit (default 20).
2. **Refetches On-Chain Events**: Queries the Soroban RPC starting at the event's ledger (`findEventForRetry`) to retrieve the original raw contract event by its unique `eventId`.
3. **Decodes the Event**: Decodes the raw contract event into a typed `StreamEvent` payload (`decodeEvent`).
4. **Applies State Updates**: Executes `applyEvent` inside a Prisma database transaction to apply the event deltas to the `Stream` table.
5. **Resolves or Updates Failure Records**: Updates the status in PostgreSQL based on the outcome of the retry attempt.

## When to Use It

Operators should run the replay command when:

- **Recovering from Transient Failures**: Downstream database hiccups, network blips, or temporary RPC timeouts may cause individual events to fail and be logged in `FailedEvent`. Once the underlying infrastructure is healthy, operators can replay them.
- **Recovering from Bug Fixes**: If an event failed due to an unhandled contract edge case or a bug in decoding/applying logic, deploy the fix and then run the replay tool to process the backlog of stuck events.
- **Verifying Recovery (Dry Run)**: Before modifying production database state, operators can simulate the replay to inspect which events will succeed or fail.
- **Avoiding Full Chain Backfills**: Because replay selectively re-applies only the failed events, there is no need to reset indexer state or re-index millions of historical ledgers.

## How to Run It

The replay tool can be invoked through `npm run replay-failed-events` or directly via `tsx`.

### Basic Execution

Process the default batch of 20 failed events:

```bash
npm run replay-failed-events
```

### Dry-Run Mode

Simulate event refetching and application without modifying the database or removing failure records:

```bash
npm run replay-failed-events -- --dry-run
```

In dry-run mode, the script logs whether each event would be applied (`dry-run: would replay failed event`) or kept (`dry-run: would keep failed event record`), and outputs a summary without altering `Stream` or `FailedEvent` tables.

### Custom Batch Limit

Limit the number of failed events processed in a single run (useful for controlled rollout or high-volume backlogs):

```bash
# Process up to 50 failed events
npm run replay-failed-events -- --limit=50

# Dry-run with a custom limit
npm run replay-failed-events -- --dry-run --limit=50
```

### Direct Invocation via TSX

```bash
npx tsx src/indexer/replay.ts --dry-run --limit=20
```

## What Happens to the Failure Record Afterward

The lifecycle of each `FailedEvent` row depends on the outcome of the replay:

- **On Success (`applied`, `duplicate`, or `reconciled`)**:
  - The event was successfully applied to the database.
  - The replay script calls `clearFailedEvent({ eventId: event.id }, tx)` within the transaction.
  - The row is **permanently deleted** from the `FailedEvent` table (`deleteMany({ where: { eventId } })`).
  - The failure is marked resolved and will no longer appear in operator queries or `/status` metrics.

- **On Failure (Event Missing or Apply Error)**:
  - If the event could not be found on-chain or threw an exception during `applyEvent`:
  - The failure record is **retained and updated in place** via `recordFailedEvent`.
  - `failureCount` is incremented by 1.
  - `error` is updated with the latest error message and stack details.
  - `lastFailedAt` is updated to the current timestamp.
  - The row remains in `FailedEvent` for further operator inspection.

- **In Dry-Run Mode**:
  - Neither `clearFailedEvent` nor `recordFailedEvent` mutates the database.
  - Failure rows in `FailedEvent` remain untouched.
