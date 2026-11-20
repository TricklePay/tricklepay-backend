# Stalled Indexer Runbook

Use this checklist when indexed data appears stale or the indexer seems to have stopped. The service exposes its last completed poll through `/status` and Prometheus metrics through `/metrics`.

## 1. Confirm that the indexer is stalled

Fetch `GET /status` twice, a few minutes apart:

```bash
curl -sS https://<service>/status
```

Compare `indexer.updatedAt`, `indexer.cursor`, `chain.latestLedger`, `indexer.lastLedger`, and `lagLedgers` between responses. `updatedAt` should advance after successful polls and the cursor should normally move when events are available. A large `lagLedgers` value by itself does not prove a stall: `lastLedger` advances only when an event is applied, so a quiet contract can leave it unchanged while polling continues. See [Understanding the Indexer Lag Figure](indexer-lag.md).

If `indexer.consecutiveFailures` is greater than zero, the poller is in backoff. The `indexer.nextPollAt` field shows the ISO 8601 timestamp of the next retry so you can tell how long to wait before the next attempt fires. For example:

```json
{
  "indexer": {
    "consecutiveFailures": 4,
    "nextPollAt": "2026-10-19T12:05:30.000Z"
  }
}
```

A `consecutiveFailures` of 4 means the retry delay is currently `min(pollInterval × 2^4, maxBackoffMs)` — up to 60 seconds with defaults. Watch the value between scrapes: if it keeps climbing, the underlying failure has not resolved.

Check `GET /health` and `GET /ready` as well. `/health` confirms the HTTP process is alive; it does not check the database or indexer. `/ready` checks database connectivity and reports the latest recorded lag, but a successful response does not prove that polls are continuing.

## 2. Check metrics

Scrape `GET /metrics` and compare samples across scrapes. The relevant metrics are:

| Metric | What to look for |
|---|---|
| `tricklepay_indexer_poll_last_success_timestamp_seconds` | Unix time of the last successful poll. If it remains unchanged while time advances, the poller is not completing ticks. A zero means no poll has completed successfully yet. |
| `tricklepay_indexer_poll_success_total` | Successful poll count. It should increase as ticks complete. |
| `tricklepay_indexer_poll_errors_total` | Unhandled poll failures. An increasing value means poll iterations are failing. |
| `tricklepay_indexer_consecutive_failures` | Current consecutive failure streak. Zero during normal operation; rises with each failure and resets on success. Use with `tricklepay_indexer_next_poll_timestamp_seconds` to understand the active backoff. |
| `tricklepay_indexer_next_poll_timestamp_seconds` | Unix timestamp of the next scheduled retry. Non-zero only while the poller is in backoff. Alert if this is far in the future combined with a high failure count. |
| `tricklepay_indexer_lag_ledgers` | Ledger gap at the last processed page. Interpret alongside the successful-poll timestamp; a large value can be normal during backfill or a quiet period. |
| `tricklepay_rpc_errors_total{operation="getContractEvents"}` | Failures fetching event pages from Soroban RPC. An increasing value points to RPC connectivity or availability. |
| `tricklepay_indexer_pages_fetched_total` | Successfully fetched event pages. It should increase when the RPC returns pages. |
| `tricklepay_indexer_events_failed_total` | Individual events skipped after decode or apply failures. These do not stop the cursor from advancing. |

For example, alert on a successful poll timestamp older than five minutes (adjust to the configured poll interval and deployment backoff):

```promql
time() - tricklepay_indexer_poll_last_success_timestamp_seconds > 300
```

Alert on an active backoff that is more than 30 seconds away from its next retry:

```promql
tricklepay_indexer_next_poll_timestamp_seconds > 0
  and (tricklepay_indexer_next_poll_timestamp_seconds - time()) > 30
```

Metrics are in-memory and reset when the process restarts. Compare their timestamps and counters only across scrapes from the same process instance.

## 3. Check application logs

Inspect logs from the running service around the time progress stopped. Search for these indexer messages and their structured fields:

- `poll iteration failed` — an unhandled tick error; inspect the attached `err` and nearby RPC/database errors.
- `event apply failed — skipping` — one event failed to apply. Check `eventId`, `ledger`, `kind`, and `streamId`. This is recorded in `FailedEvent`; by itself it does not mean the poller is stalled.
- `malformed event — skipping` — an event could not be decoded and was skipped; inspect `eventId` and `ledger`.
- `could not persist failed-event record` — the indexer also failed to record a skipped event; investigate database health.
- `cursor regression detected — skipping page` — RPC returned a cursor older than the saved cursor; inspect RPC behavior.
- `reached max pages per tick — continuing next poll` — expected when a backlog is processed in bounded batches; confirm successful polls continue.
- `drained event backlog` — the poller completed a multi-page backlog. This is an informational progress message.

Also look for `indexer stopped`, `failed to start service`, database connection errors, and deployment or container restarts. Poll failures use exponential backoff up to `INDEXER_MAX_BACKOFF_MS`, so retries may become less frequent during a prolonged outage.

## 4. Recover in order

1. **Resolve the failing dependency.** If logs or `tricklepay_rpc_errors_total` point to Soroban RPC, check the configured RPC URL and provider availability. If database errors appear, restore PostgreSQL connectivity and verify the database is accepting writes. Correct deployment configuration or credentials if they are wrong.
2. **Allow retries to work.** The poller retries failed iterations automatically with backoff. Watch `tricklepay_indexer_poll_last_success_timestamp_seconds`, `tricklepay_indexer_poll_success_total`, and `indexer.updatedAt` for movement after the dependency recovers.
3. **Restart the service if polling does not resume.** Use the deployment platform's normal restart procedure after checking the process logs. On startup, the indexer resumes from its saved database cursor. Do not delete or edit `IndexerState`, reset the database, or change `INDEXER_START_LEDGER` as a stall-recovery step; a saved cursor takes precedence, and removing state can cause an unintended re-index or data gap.
4. **Handle individual failed events separately.** If the poller is progressing but `failedEventCount` or `tricklepay_indexer_events_failed_total` is elevated, investigate the `FailedEvent` records and underlying error. After fixing the cause, preview retries with `npm run replay-failed-events -- --dry-run --limit 20`, then replay a controlled batch with `npm run replay-failed-events -- --limit 20`. See [Event Replay Guide](event-replay.md).
5. **Verify recovery.** Confirm the successful-poll timestamp and count advance, `indexer.updatedAt` changes, pages are fetched as expected, and the error rate stops increasing. During backfill, `lagLedgers` should generally shrink; during a quiet contract period it may stay large while polls continue successfully.

If progress still does not resume, preserve the relevant logs, `/status` responses, and metric samples with timestamps for further investigation.
