# Failed Events Retention Guide

The `FailedEvent` table in the TricklePay backend stores chain events that the indexer could not process. These rows are valuable for debugging and recovery when edge cases occur. However, on a long-running indexer, this table can grow indefinitely.

## Retention Policy

We recommend retaining failed events for at least **30 to 60 days**. This provides sufficient time for operators to review incidents and extract debugging information. 

Events older than this window that have already been reviewed or resolved may be safely deleted.

## Cleanup Instructions

When cleaning up failed events, ensure you only delete records from the `FailedEvent` table and do not interfere with active stream state in the `Stream` table.

You can safely run the following cleanup query via your PostgreSQL client to delete failed events older than 30 days:

```sql
DELETE FROM "FailedEvent" 
WHERE "createdAt" < NOW() - INTERVAL '30 days';
```

### Scheduled Maintenance

If you run a heavy load, you might consider running this query as a scheduled task (e.g. via `cron` or a pgAgent job) to keep the database size manageable without manual intervention.
