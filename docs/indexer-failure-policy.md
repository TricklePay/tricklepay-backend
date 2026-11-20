# Indexer Failure Policy

## What happens when an event fails to apply

When the indexer encounters a contract event that cannot be successfully processed, it follows a **skip-and-record** policy rather than stopping the entire indexing process:

1. **The event is logged**: The failure is written to the server logs with the event ID, ledger, stream ID, and error details.
2. **The failure is recorded**: A row is inserted or updated in the `FailedEvent` table with:
   - The event ID and ledger sequence
   - The transaction hash when available
   - The decoded event kind (or `"unknown"` if decoding itself failed)
   - The target stream ID when available
   - The error message from the failed attempt
   - A failure count that increments with each retry
   - Timestamps for first and last failure
3. **The event is skipped**: The indexer continues processing the remaining events in the same page.
4. **The cursor advances**: After the page completes, the cursor is saved and the indexer moves forward. The failed event does not block progress.

## The trade-off being made

This policy prioritizes **liveness over completeness**:

- **Liveness**: The indexer continues making forward progress even when individual events are malformed or cause unexpected errors. One bad event cannot stall the entire mirror.
- **Completeness**: Some events may not be applied immediately, leaving gaps in the indexed data until they are manually investigated and replayed.

### Why this trade-off?

In a production system, it's more important that the indexer stays synchronized with the chain and serves data for healthy streams than for it to halt entirely because of a single corrupt or unexpected event. The alternative—stopping the indexer on any failure—would mean:
- All API queries return stale data until an operator intervenes
- New streams created after the failure are not indexed
- The service cannot recover automatically from transient issues

By recording failures and continuing, operators can:
- Investigate failures asynchronously without service downtime
- Retry failed events in controlled batches using the replay tool
- Identify systematic issues (e.g., contract upgrade incompatibilities) without blocking all indexing

## Where failures are recorded

Failed events are stored in the **`FailedEvent` table** in PostgreSQL. Each row contains:

| Column | Description |
|--------|-------------|
| `eventId` | The unique event identifier from Soroban RPC (TOID-index format) |
| `kind` | The decoded event type (`created`, `withdrawn`, `cancelled`, or `unknown`) |
| `streamId` | The target stream ID as a string, when available |
| `ledger` | The ledger sequence where the event was observed |
| `txHash` | Transaction hash when available; null for older rows or unavailable hashes |
| `error` | The exception message from the most recent failure |
| `failureCount` | Number of times this event has failed to apply |
| `firstFailedAt` | Timestamp of the first failure |
| `lastFailedAt` | Timestamp of the most recent failure |

### Inspecting failures

Failed events can be inspected using:

**SQL query** (direct database access):
```sql
SELECT "eventId", "kind", "streamId", "ledger", "txHash", "failureCount", "error" 
FROM "FailedEvent" 
ORDER BY "ledger" ASC 
LIMIT 20;
```

**API endpoint**: The `/status` endpoint includes a `failedEventCount` field showing the total number of unresolved failures.

**Replay tool** (dry-run mode):
```bash
npm run replay-failed-events -- --dry-run --limit 20
```

### Retrying failed events

Operators can manually retry failed events using the replay tool:

```bash
# Retry the next 20 failed events in ledger order
npm run replay-failed-events -- --limit 20
```

Successfully replayed events are automatically removed from the `FailedEvent` table. See [event-replay.md](event-replay.md) for detailed instructions.

## When failures indicate a problem

A non-zero `failedEventCount` is not always critical, but certain patterns warrant investigation:

- **Growing failure count**: If failures accumulate over time, it may indicate a systematic issue (e.g., contract schema change, database constraint violation, or indexer bug).
- **Repeated failures for the same event**: If `failureCount` is high for specific events, they may be genuinely malformed or incompatible with the current indexer logic.
- **Failures after a contract upgrade**: A spike in failures following a contract deployment may mean the indexer needs to be updated to handle new event formats.

## Related documentation

- [event-replay.md](event-replay.md): How to inspect and retry failed events
- [failed-events-retention.md](failed-events-retention.md): Data retention policy for failed event records
- [database-schema.md](database-schema.md): Complete schema for the `FailedEvent` table

## Implementation details

The failure handling logic is implemented in:
- `src/indexer/poller.ts`: Catches application errors, logs them, records failed events, and continues processing
- `src/repositories/failed-events.ts`: Functions for recording and clearing failed event records
- `src/indexer/apply.ts`: Event application logic that may throw errors caught by the poller
