# Indexer Start Ledger

## What the start ledger controls

The `INDEXER_START_LEDGER` environment variable determines the earliest ledger sequence the indexer will scan for contract events when starting from a fresh database with no saved cursor position.

The `GET /status` response reports this configured value as `indexer.startLedger`. A value of `0` means the indexer starts from the chain's current head when there is no saved cursor; the reported value does not replace `indexer.lastLedger`, which is the current indexed position.

When the indexer starts:
1. If a saved cursor exists in the database, the indexer resumes from that cursor (the start ledger is ignored).
2. Otherwise, if `INDEXER_START_LEDGER` is set to a positive integer, the indexer begins scanning from that ledger sequence. If the configured ledger is beyond the chain's current head, startup fails with an error explaining the mismatch rather than waiting for a ledger that does not exist yet.
3. If `INDEXER_START_LEDGER` is `0 or unset (default), the indexer starts from the chain's current head ledger, indexing only new activity going forward.

## How to choose a value

### For a new deployment with no historical data needed
Set `INDEXER_START_LEDGER=0` (or omit it entirely). The indexer will start from the chain's current head and index only events that occur after startup. This is the fastest option when you don't need to backfill historical stream data.

### For a new deployment that needs historical streams
Set `INDEXER_START_LEDGER` to the ledger sequence at or before the contract's first `Created` event. You can find this by:
- Checking when the stream contract was deployed
- Identifying the earliest stream creation you need to index
- Setting the start ledger a few hundred ledgers before that point to ensure nothing is missed

For example, if your contract's first stream was created at ledger `56000000`, set:
```
INDEXER_START_LEDGER=55999500
```

### For migrations or re-indexing
If you're rebuilding the database from scratch with an existing contract, set the start ledger to when the contract was deployed or earlier. The indexer will backfill all historical events up to the current chain head.

## What happens when set too high

If `INDEXER_START_LEDGER` is set higher than the chain's current head ledger, the indexer refuses to start and logs an error naming the configured ledger and the chain head. This is deliberate: the indexer would otherwise sit waiting for a ledger that does not exist yet, which looks identical to a broken RPC endpoint. Set the value at or below the chain head, or to `0` to start from the head.

If `INDEXER_START_LEDGER` is set higher than the contract's first events (but not beyond the chain head):
- Streams created before the start ledger will never be indexed
- `Withdrawn` or `Cancelled` events for those streams will fail to apply (the stream won't exist in the database)
- Failed events will be logged and recorded in the `FailedEvent` table
- The indexer will attempt to reconcile missing streams by fetching full state from the contract via RPC, which adds latency

**Impact**: Missing historical data and increased RPC load during backfill as the indexer repeatedly tries to reconcile streams that were created before the start ledger.

## What happens when set too low

If `INDEXER_START_LEDGER` is set earlier than necessary (e.g., before the contract existed):
- The indexer scans empty ledgers that contain no relevant events
- Backfill takes longer to reach the first actual stream event
- More RPC calls are made to fetch event pages that contain nothing

**Impact**: Slower initial sync and unnecessary RPC load, but no data is lost. Once the indexer reaches ledgers with actual events, indexing proceeds normally.

## Recommendations

- **Production deployments**: Set the start ledger to slightly before the contract deployment ledger (e.g., 500-1000 ledgers earlier as a safety margin).
- **Development/testing**: Use `INDEXER_START_LEDGER=0` to start fresh and only index new activity.
- **After initial sync**: The saved cursor in the database takes precedence, so changing `INDEXER_START_LEDGER` has no effect on a running indexer with existing state.

## Related configuration

-  `INDEXER_POLL_INTERVAL_MS`: Controls how frequently the indexer polls for new events
-  `INDEXER_MAX_PAGES_PER_TICK`: Limits how many event pages are processed per poll iteration during backfill

## Related configuration

See the main [README Configuration section](../README.md#configuration) for complete environment variable documentation.
