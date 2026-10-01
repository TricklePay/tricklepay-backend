# Understanding the Indexer Lag Figure

The `GET /status` endpoint returns a field called `lagLedgers`. This document explains exactly what it measures, how it is calculated, what a large value implies, and — crucially — what it does **not** imply.

---

## What `lagLedgers` measures

`lagLedgers` is the gap in ledger height between the Stellar network's current chain head and the highest ledger whose contract events the indexer has **successfully applied** to the database:

```
lagLedgers = chainLedger - lastLedger
```

Both values come from the same `IndexerState` row, written at the end of each indexer poll. The subtraction is floored at zero: the indexer's position can never legitimately exceed the chain head, because both are recorded in the same atomic poll.

```ts
// src/routes/status.ts
lagLedgers: position ? Math.max(0, position.chainLedger - position.lastLedger) : null,
```

`lagLedgers` is `null` before the indexer has completed its first poll — no position has been recorded yet, so reporting zero would falsely imply the indexer is caught up.

---

## What each field in `GET /status` contributes

```json
{
  "indexer": {
    "initialized": true,
    "lastLedger": 56290013,
    "cursor": "0241763773516349440-0000000001",
    "updatedAt": "2025-11-14T03:00:00.000Z"
  },
  "chain": {
    "latestLedger": 56999999
  },
  "lagLedgers": 709986,
  "failedEventCount": 0
}
```

| Field | Meaning |
|---|---|
| `indexer.lastLedger` | The highest ledger from which contract events have been applied. Only advances when an event from a new ledger is persisted. |
| `chain.latestLedger` | The chain head at the time of the last indexer poll. Sourced from Soroban RPC, not from a live chain query. |
| `lagLedgers` | `chain.latestLedger − indexer.lastLedger`, floored at zero. |
| `indexer.updatedAt` | When the indexer last wrote a position. A timestamp that does not advance is a sign that the indexer has stopped. |
| `indexer.cursor` | The RPC pagination cursor, not used in lag calculation. See below. |

---

## What a large `lagLedgers` value means

A large `lagLedgers` value means the indexer is **behind the chain head by that many ledgers**. This happens in two situations:

1. **Backfill in progress.** A freshly deployed instance starts indexing from `INDEXER_START_LEDGER`, which may be many ledgers behind the current chain head. During a backfill, `lagLedgers` can be hundreds of thousands or more, and it will steadily shrink as the indexer catches up.

2. **The indexer has stopped or is processing slowly.** If `lagLedgers` is large and `indexer.updatedAt` is not advancing, the indexer process is likely unhealthy and requires investigation.

---

## What a large `lagLedgers` value does NOT mean

> **A large `lagLedgers` value does not necessarily mean there has been an indexing delay or missed activity.**

The most common misreading: an operator sees `lagLedgers: 500000` and concludes that "five hundred thousand ledgers worth of activity was missed." This is usually wrong.

`lastLedger` only advances when a ledger contains a **contract event that the indexer processes**. If the stream contract has been quiet — no streams created, no withdrawals, no cancellations — the `lastLedger` column stays at its previous value even though the indexer has polled every ledger in between. The `cursor` field advances continuously regardless of whether events were found; `lastLedger` does not.

**Concrete example:**

- Contract deployed at ledger 55 000 000.
- No contract activity from ledger 55 000 000 to 56 000 000.
- Current chain head: 56 999 999.
- `lastLedger`: 55 000 000.
- `lagLedgers`: 1 999 999.

This does **not** mean nearly two million ledgers of transactions were missed. It means the last ledger that had a contract event the indexer cared about was 55 000 000. The indexer is fully caught up; there is simply nothing new to record.

---

## How to distinguish "caught up but quiet" from "genuinely behind"

Compare `lagLedgers` with `indexer.updatedAt`:

| `lagLedgers` | `updatedAt' advancing? | Interpretation |
|---|---|---|
| Small or zero | Yes | Indexer is keeping up; contract is active. |
| Large | Yes | Backfill in progress, or contract has been quiet. Normal. |
| Large | No | Indexer has likely stopped. Investigate. |
| `null` | — | First poll has not completed yet. |

If `updatedAt` is advancing and `lagLedgers` is large but stable (not growing), the indexer is healthy and the contract has simply not emitted events for a while.

If `updatedAt` is advancing and `lagLedgers` is shrinking, a backfill is in progress.

If `updatedAt` has not changed in several minutes, the indexer process may have crashed or stalled.

---

## Readiness signal

The `GET /ready` readiness probe reflects whether the indexer has made progress, not merely whether dependencies answer. A freshly started instance that has not yet completed a indexer poll reports not ready, even if the database and Soroban RPC are reachable.

Readiness is determined by the presence of an `IndexerState` position with a non-null `indexer.updatedAt`. Once the indexer has written its first position, the service is considered ready. This is intentionally independent of lag: a backfilling indexer with a large `lagLedgers` is still ready, because it has usable data and is making progress.

Liveness (`GET /health`) is unaffected by this change: liveness continues to reflect only whether the process is running and able to respond.

---

## Implementation reference

The lag calculation lives in two places in the source:

- **`src/routes/status.ts`** — the `GET /status` response body:
  ```ts
  lagLedgers: position ? Math.max(0, position.chainLedger - position.lastLedger) : null,
  ```

- **`src/server.ts`** — the `GET /ready` readiness probe applies the same formula:
  ```ts
  const lagLedgers = position
    ? Math.max(0, position.chainLedger - position.lastLedger)
    : null;
  ```

Both derive the figure from the same `IndexerState` row, so `/status` and `/ready` always report the same lag at any given moment.
