# Failed Events Retention Guide

The `FailedEvent` table in the TricklePay backend stores chain events that the indexer could not process. These rows are valuable for debugging and recovery when edge cases occur. However, on a long-running indexer, this table can grow indefinitely.

## Retention Policy

We recommend retaining failed events for at least **30 to 60 days**. This provides sufficient time for operators to review incidents and extract debugging information. 

Before deleting records, operators should attempt to reprocess actionable failures using the replay tool. See [Event Replay Guide](event-replay.md) for instructions on retrying failed events.

Events older than this window that have already been reviewed or resolved may be safely deleted.

## Automated Cleanup Tool

To automate failed event cleanup according to this retention policy, use the `prune-failed-events` command:

```bash
# Preview how many records would be deleted without modifying data
npm run prune-failed-events -- --older-than=30d --dry-run

# Delete failed events older than 30 days
npm run prune-failed-events -- --older-than=30d
```

### Options:
- `--older-than=<age>`: Required. Retention window threshold (e.g. `30d`, `60 days`, `24h`, or a plain number of days `30`). Events first failed before this cutoff are pruned.
- `--dry-run`: Optional. Only counts and logs matching records without deleting them.

## Manual Cleanup Instructions

Inspect the failures before deleting them. The nullable `txHash` identifies the
transaction to investigate; older records or events without a hash contain null.

```sql
SELECT "eventId", "kind", "streamId", "ledger", "txHash", "error"
FROM "FailedEvent"
WHERE "firstFailedAt" < NOW() - INTERVAL '30 days'
ORDER BY "ledger" ASC, "eventId" ASC;
```

When cleaning up failed events manually via SQL, ensure you only delete records from the `FailedEvent` table and do not interfere with active stream state in the `Stream` table.

You can safely run the following cleanup query via your PostgreSQL client to delete failed events older than 30 days:

```sql
DELETE FROM "FailedEvent" 
WHERE "firstFailedAt" < NOW() - INTERVAL '30 days';
```

### Scheduled Maintenance

If you run a heavy load, you might consider running the prune command or cleanup query as a scheduled task (e.g. via `cron` or a pgAgent job) to keep the database size manageable without manual intervention.
