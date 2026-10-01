# Database Outage Runbook

Use this checklist when PostgreSQL is unavailable, cannot accept connections, or is responding too slowly. The read API and indexer use the same database but show different symptoms: database-backed API requests fail individually, while the indexer may stop completing poll iterations and retry in the background.

## Symptoms to expect

- **Read API requests:** Endpoints that query PostgreSQL can return HTTP 500 when a database operation fails or times out. Error responses are redacted; the server log records `request failed` with the request ID and underlying error. Request-scoped reads use a 5-second wait bound, but Prisma does not cancel the underlying query when that bound expires.
- **Readiness:** `GET /ready` returns HTTP 503 with `database: "down"` when its database health check fails or takes longer than 5 seconds. A successful `GET /health` only confirms that the HTTP process is alive; it does not check PostgreSQL.
- **Indexer:** Database errors during event application or cursor persistence can cause events to be skipped or a poll iteration to fail. Unhandled poll failures are logged as `poll iteration failed`; the poller backs off and retries. `/status` also depends on PostgreSQL and may itself fail during an outage.

## Check in order

1. Check `GET /ready` and `GET /health` to separate database readiness from HTTP process liveness.
2. Inspect PostgreSQL availability, connection limits, storage, and logs. Look for unavailable connections, exhausted connection slots, disk-full errors, or slow queries.
3. Review service logs for `request failed`, `poll iteration failed`, `event apply failed — skipping`, and `could not persist failed-event record`. Use request IDs and event IDs to correlate errors.
4. Compare the metrics below across scrapes. They are in-memory and reset when the API process restarts.

## Relevant metrics

There is currently **no dedicated database error counter or database connection metric**. Use readiness, request outcomes, poll activity, and logs together rather than treating any one metric as a definitive database signal.

| Metric | How it helps |
|---|---|
| `tricklepay_http_requests_total{status="500"}` | An increase shows server errors returned to clients. Check the matching route and service logs to determine whether PostgreSQL is the cause. |
| `tricklepay_http_request_duration_ms` | Review request durations by route and status. Slow database-backed requests may precede timeouts or 500 responses. |
| `tricklepay_indexer_poll_errors_total` | An increase means poll iterations failed. Check logs for database errors as well as RPC failures. |
| `tricklepay_indexer_poll_last_success_timestamp_seconds` | If this timestamp stops advancing while database errors appear, the indexer is not completing polls. |
| `tricklepay_indexer_poll_success_total` | Should resume increasing when poll iterations complete successfully after recovery. |
| `tricklepay_indexer_events_failed_total` | May increase when event application fails. Check whether the cause was a database error and whether failed events were recorded for replay. |
| `tricklepay_indexer_failed_events` | Current number of unresolved failed-event records. It is refreshed at startup and after indexer pages or replay operations; compare it across scrapes to see whether the backlog is growing or clearing. |

`GET /metrics` exposes these samples. The `/ready` endpoint is a direct database check and is often the clearest immediate signal.

## What recovers automatically

- When PostgreSQL becomes reachable again, the API can serve successful database-backed requests without an application restart. Clients should retry failed requests according to their own retry policy.
- A poll iteration that fails after the poll loop has started is retried automatically with exponential backoff. Successful polls reset the backoff. See [Indexer Retry and Backoff](indexer-retry-backoff.md).
- An event whose application fails may be recorded in `FailedEvent`; this lets the poller continue instead of blocking on one event. The event is not guaranteed to be applied automatically just because the database recovers. Check the failed-event records after service recovery.

## Recovery actions

1. Restore PostgreSQL service and connectivity. If the cause is capacity related, free or expand storage, restore connection capacity, or address the slow query/load condition before relying on retries.
2. Confirm `GET /ready` returns HTTP 200 with `database: "up"`. Then confirm API requests succeed and the poll success count and last-success timestamp advance.
3. Check `GET /status` and `failedEventCount` once the database is available. Review database and application logs for events that failed while the outage was active.
4. If unresolved failed events remain, identify and resolve their underlying cause, preview a retry with `npm run replay-failed-events -- --dry-run --limit 20`, then replay a controlled batch with `npm run replay-failed-events -- --limit 20`. See [Event Replay Guide](event-replay.md).
5. Restart the API process only if it remains unhealthy after PostgreSQL is restored, or if it exited. A temporary database outage alone should not require deleting or resetting indexer state.

If the indexer poll success timestamp remains stale or `/ready` remains down after the database is restored, preserve service and database logs with timestamps and investigate connection configuration, capacity, and any persistent event-level failures.
