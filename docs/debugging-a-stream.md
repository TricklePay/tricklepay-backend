# Debugging a Single Stream

`IndexedEvent` is an append-only audit log: the indexer writes a row for
every event it decodes for a stream, independently of whether applying that
event to the `Stream` table succeeded. That makes it possible to reconstruct
exactly how a stream reached its current state — or to prove that it hasn't,
and find out why — without touching the chain. This guide gives the queries
for that, run directly against Postgres (`psql $DATABASE_URL` or any client).

See [database-schema.md](database-schema.md) for the full field reference on
both tables used here.

## 1. Pull the stream's current row

```sql
SELECT "streamId", "sender", "recipient", "token", "totalAmount", "withdrawn",
       "cancelled", "startTime", "endTime", "cliffTime",
       "createdLedger", "updatedLedger", "lastEventId"
FROM "Stream"
WHERE "streamId" = '42';
```

`updatedLedger` and `lastEventId` are the two fields that matter for
debugging: they record the ledger and event id of the most recent event this
row actually absorbed. This is the same data `GET /streams/42` serves.

## 2. List the stream's events in order

```sql
SELECT "eventId", "kind", "ledger", "amount", "recipientAmount",
       "senderRefund", "totalAmount", "txHash"
FROM "IndexedEvent"
WHERE "streamId" = '42'
ORDER BY "eventId" ASC;
```

This is the same query and ordering `GET /streams/42/events` uses
(`eventId` is a `TOID-index` string, so ascending text order is chronological
chain order). You should see exactly one `created` event, followed by zero or
more `withdrawn` events, optionally followed by one `cancelled` event — a
`created` event anywhere but first, or more than one `created` or `cancelled`
row, means something upstream of the indexer (or a reused stream id) is
already wrong, not an indexing bug.

## 3. Compare the two

Two things should always line up:

- **The tail of the event list matches the stored pointer.** The last row's
  `eventId` should equal `Stream.lastEventId`, and its `ledger` should equal
  `Stream.updatedLedger`. The repository layer only ever advances these two
  fields together, in the same write that applies an event
  (`src/repositories/streams.ts`), so they drift apart only when a later
  event was logged but never applied.
- **The running total matches the sum of the deltas.** For a stream that
  hasn't been cancelled, `Stream.withdrawn` should equal the sum of `amount`
  across its `withdrawn` rows:

  ```sql
  SELECT
    s."withdrawn" AS stored_withdrawn,
    COALESCE(SUM(ie."amount"), 0) AS sum_of_withdrawn_events
  FROM "Stream" s
  LEFT JOIN "IndexedEvent" ie
    ON ie."streamId" = s."streamId" AND ie."kind" = 'withdrawn'
  WHERE s."streamId" = '42'
  GROUP BY s."withdrawn";
  ```

  For a **cancelled** stream, the contract freezes `totalAmount` and
  `withdrawn` to the same frozen figure at cancellation — the withdrawn total
  up to that point plus the recipient's cancellation payout (see
  `applyCancellation` in `src/repositories/streams.ts`). So the check becomes
  `stored_withdrawn == sum_of_withdrawn_events + recipientAmount` using the
  `recipientAmount` from the stream's `cancelled` row.

If both checks pass, the stored row is a faithful summary of its own event
history — the normal case.

## What a gap looks like

A **gap** is an `IndexedEvent` row that exists but was never folded into the
`Stream` row: its `eventId` sorts after `Stream.lastEventId` (equivalently,
its `ledger` is greater than `Stream.updatedLedger`). Find it with:

```sql
SELECT ie."eventId", ie."kind", ie."ledger"
FROM "IndexedEvent" ie
JOIN "Stream" s ON s."streamId" = ie."streamId"
WHERE ie."streamId" = '42' AND ie."eventId" > s."lastEventId"
ORDER BY ie."eventId" ASC;
```

Any row this returns is an event the chain emitted and the indexer logged,
but that never updated the stream's balance — the signature of the
skip-and-record failure policy, not of a missing or dropped event (see
[indexer-failure-policy.md](indexer-failure-policy.md)). Confirm it by
looking up the same `eventId` in `FailedEvent`:

```sql
SELECT "eventId", "kind", "failureCount", "error", "lastFailedAt"
FROM "FailedEvent"
WHERE "eventId" = '<eventId from the gap query>';
```

A match there is the cause. Once the underlying error is understood (and, if
it was a bug, fixed), the gap is closed with the replay tool — see
[event-replay.md](event-replay.md) — not by editing the `Stream` row by hand.
If the gap query returns a row but `FailedEvent` has no matching entry, that
is a more serious anomaly (the apply may have failed silently, e.g. a database
write that errored after `FailedEvent` itself failed to record — see the
"could not persist failed-event record" log line in
[indexer-stalled-runbook.md](indexer-stalled-runbook.md)) and is worth
escalating with both query results attached.

## What a duplicate (or over-counted) balance looks like

Because `IndexedEvent.eventId` is a primary key and inserts use
`skipDuplicates`, the same on-chain event can never produce two rows — so a
"duplicate" here isn't a repeated row, it's `Stream.withdrawn` ending up
*larger* than the sum computed in step 3, or two distinct `withdrawn` rows at
adjacent ledgers for the stream carrying the same `amount` that look like one
withdrawal counted twice:

```sql
SELECT "eventId", "ledger", "amount"
FROM "IndexedEvent"
WHERE "streamId" = '42' AND "kind" = 'withdrawn'
ORDER BY "eventId" ASC;
```

Two adjacent rows with the same `amount` are not automatically a bug — a
recipient can legitimately withdraw the same figure twice. Treat it as
suspicious only alongside the sum mismatch in step 3. One known, legitimate
reason the sum can appear to disagree without any duplication: a backfill
that starts after a stream's `created` event reconciles that stream's row by
reading full state from the contract (`orReconcile` in
`src/indexer/apply.ts`) instead of applying a delta — the resulting
`Stream.withdrawn` reflects everything the contract has ever recorded for
that stream, including withdrawals from before the indexer's event history
begins, so it can legitimately exceed the sum of this stream's *own* logged
`withdrawn` rows. Check whether the stream's `created` event is actually
present in step 2's output before treating a mismatch as a bug.

## Related documentation

- [event-replay.md](event-replay.md): How to replay the events found by the gap query above.
- [indexer-failure-policy.md](indexer-failure-policy.md): Why failures are skipped and recorded rather than blocking the indexer.
- [failed-events-retention.md](failed-events-retention.md): How long resolved and unresolved `FailedEvent` rows are kept.
- [database-schema.md](database-schema.md): Full field reference for `Stream`, `IndexedEvent`, and `FailedEvent`.
