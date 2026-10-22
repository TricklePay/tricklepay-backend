# TricklePay Backend

Indexer and read API for TricklePay token streams on Stellar

This service has two halves that run in one process:

- An **indexer** that polls the stream contract's events over Soroban RPC and
  keeps a Postgres mirror of every stream's state.
- A **read API** that serves that data over HTTP, computing live vested and
  withdrawable amounts on each request so clients never have to query the chain
  directly.

It backs the TricklePay web client and pairs with the
[contracts](#related-repositories) repository, which holds the on-chain logic.
For a record of API and indexer behavior changes, see the [Changelog](CHANGELOG.md).
For guides and technical documentation, see the [Documentation Index](docs/README.md).

## Table of Contents

- [How it works](#how-it-works)
- [Documentation](#documentation)
- [Database schema](#database-schema)
- [Glossary](#glossary)
- [API](#api)
- [Error Responses](#error-responses)
- [Health Endpoint Semantics](#health-endpoint-semantics)
- [Metrics](#metrics)
- [Running locally](#running-locally)
- [Testing](#testing)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Project structure](#project-structure)
- [Frequently asked questions](#frequently-asked-questions)
- [Troubleshooting](#troubleshooting)
- [Related repositories](#related-repositories)
- [License](#license)

## How it works

The contract emits `Created`, `Withdrawn`, and `Cancelled` events, and between
them they carry everything the mirror needs. `Created` holds a whole stream —
sender, recipient, token, total, and the `startTime`/`endTime`/`cliffTime`
schedule, with `withdrawn` at zero and `cancelled` false by definition — while
`Withdrawn` and `Cancelled` carry the deltas that move one. So the indexer
writes each event straight to Postgres: one query per event and no chain
round-trip. That is what makes a backfill so cheap, since an historical event costs
a database write rather than an RPC simulation.

Applying an event twice therefore has to be harmless, because the indexer saves
its cursor only after finishing a page and re-reads that page if it restarts
mid-way. Each row records the id of the last event applied to it — the RPC's
zero-padded `TOID-index`, which compares as a string in chain order. `Created`
inserts only when the stream is absent, so a replay cannot reset `withdrawn` on
a stream that has since paid out, and a delta applies only to a row whose last
event predates it. Replaying a page changes nothing.

`get_stream` remains for reconciliation. When a delta arrives for a stream that
is not stored — an indexer backfilling from a ledger after that stream was
created, say — there is nothing to apply it to, so full contract state is read
once and the row written whole. That is one read per stream, not per event: from
then on the stream is back on the event path.

Alongside the stream rows the indexer keeps one row of bookkeeping: the RPC
cursor to resume from (`cursor`), the highest ledger it has actually applied
events through (`lastLedger`), and the chain's head as of its last poll
(`chainLedger`). These are not the same thing, and the difference matters:
`cursor` is an opaque RPC paging token that advances on every poll — including
one whose page has no matching events — because it only marks how far the RPC
has been asked to scan. `lastLedger` only moves forward when an event is
actually applied to Postgres, so a page with no events leaves it exactly where
it was. Lag is therefore computed as `chainLedger - lastLedger`, never from the
cursor: a cursor sailing through a stretch of quiet ledgers would otherwise look
identical to real progress, letting a genuinely backlogged indexer read as level
with the chain. `cursor` and `lastLedger` are what let the indexer crash and
resume without reprocessing; `lastLedger` and `chainLedger` are what `/status`
subtracts to report lag.

The API reads only from Postgres, and not every field it returns is a stored
column. `id`, `sender`, `recipient`, `token`, `totalAmount`, `withdrawn`,
`startTime`, `endTime`, `cliffTime`, and `cancelled` are stored — copied
straight from the indexed row. `vested`, `withdrawable`, `locked`, `progress`,
and `status` are derived: computed on every request, against the current clock,
using the same linear vesting formula the contract itself evaluates on-chain.
That means these figures track wall-clock time rather than the last indexed
event — a stream's `vested` amount can be higher on a second request than the
first even though the indexer applied nothing in between — and they agree with
what the contract would report if queried directly, without ever making that
chain round-trip. For a detailed explanation of why these figures are computed per request and how consistency with the chain is preserved, see [Derived Figures and Real-Time Vesting](docs/derived-figures.md).

## Documentation

Comprehensive technical documentation and operational guides are maintained in the [`docs/`](docs/README.md) directory:

- [docs/README.md](docs/README.md): Index of all documentation guides and specifications.
- [docs/database-schema.md](docs/database-schema.md): Complete schema documentation for all PostgreSQL models and audit tables.
- [docs/event-replay.md](docs/event-replay.md): Operator guide for running the failed event replay recovery CLI.
- [docs/debugging-a-stream.md](docs/debugging-a-stream.md): Queries to reconstruct a single stream from its event history and spot a gap or duplicate.
- [docs/poll-tick-sequence.md](docs/poll-tick-sequence.md): Sequence diagram of a single poll tick, from fetching events to saving the indexer's position.
- [docs/failed-events-retention.md](docs/failed-events-retention.md): Retention policy and maintenance procedures for failed event records.
- [docs/glossary.md](docs/glossary.md): Terminology definitions for domain and indexer concepts.

## Database schema

The service uses PostgreSQL via Prisma. Database state is divided into four tables:

- **`Stream`**: Stores the current state of each indexed token stream (amounts as wide fixed-point decimals, schedule timestamps as Unix seconds). Updated idempotently using `lastEventId` to guard against duplicate or out-of-order event application.
- **`IndexedEvent`**: An immutable log of raw decoded contract events (`Created`, `Withdrawn`, `Cancelled`) processed by the indexer.
- **`FailedEvent`**: Records contract events that failed during processing or database application, allowing operators to inspect and retry failed events via `npm run replay-failed-events`.
- **`IndexerState`**: Single-row bookkeeping table storing indexer progress (`lastLedger`), latest Stellar network height (`chainLedger`), and RPC paging position (`cursor`).

### Entity Relationships

- **`Stream` ↔ `IndexedEvent`**: `IndexedEvent` records raw event logs; applied events update `Stream` rows. `Stream.lastEventId` ensures delta updates apply idempotently.
- **`Stream` ↔ `FailedEvent`**: `FailedEvent` logs unapplied events by `streamId` when available for debugging and retry.
- **`IndexerState` ↔ `Stream` & `IndexedEvent`**: `IndexerState.lastLedger` records the block height through which all events and streams have been synced. `IndexerState.cursor` tracks the Soroban RPC event pagination marker.

For full field descriptions, data types, indexes, and relationship details, see [docs/database-schema.md](docs/database-schema.md).

## Glossary

Core indexer terms used across code and documentation include:

- **Cursor**: Opaque Soroban RPC pagination marker (`IndexerState.cursor`). Advances on every poll tick regardless of whether events were found.
- **Ledger**: Sequential block height on the Stellar network (e.g. `lastLedger`, `chainLedger`).
- **Backfill**: Indexer catch-up phase scanning historical events from an earlier ledger up to chain head.
- **Lag**: Calculated difference in ledgers between chain height and indexer applied position (`chainLedger - lastLedger`).
- **Applied Event**: Contract event whose state updates have been successfully persisted to PostgreSQL (`Stream` and `IndexedEvent`).

For complete definitions and supporting terms, see [docs/glossary.md](docs/glossary.md).

## API

The service exposes a REST API for querying indexed stream data and checking system health. An interactive OpenAPI (Swagger) viewer and machine-readable specification are served alongside the data endpoints.

### API Specification

| Path | Format | Description |
| --- | --- | --- |
| `/docs` | HTML | Interactive Swagger UI for exploring and testing the API |
| `/docs/json` | JSON | OpenAPI 3.0 specification in JSON format |
| `/docs/yaml` | YAML | OpenAPI 3.0 specification in YAML format |

The specification is **generated automatically** from route schemas defined in the codebase. When you add or modify an endpoint in `src/routes/`, the OpenAPI document updates accordingly. The generation is handled by `@fastify/swagger` and `@fastify/swagger-ui`.

Set `ENABLE_DOCS_UI=false` to disable only the interactive page: `/docs` and its static assets return 404, while `/docs/json` and `/docs/yaml` keep serving the machine-readable document.

The document's `info.contact` entry points readers at the project repository, and its `servers` entry is built from configuration: it uses `PUBLIC_BASE_URL` when set, otherwise a URL derived from `HOST` and `PORT`, so generated clients get a sensible base URL to default to.

**Accessing the specification:**

```bash
# View the interactive docs in a browser
open http://localhost:3000/docs

# Fetch the JSON spec programmatically
curl http://localhost:3000/docs/json > openapi.json

# Fetch the YAML spec
curl http://localhost:3000/docs/yaml > openapi.yaml
```

For generating a typed TypeScript client from `/docs/json` for a frontend or
third-party integration, see
[docs/openapi-client-generation.md](docs/openapi-client-generation.md). For
exactly which `Cache-Control`, `ETag`, and other headers each endpoint sets
and why, see [docs/response-headers.md](docs/response-headers.md).

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Service index: name, version, and a list of endpoints. |
| `GET` | `/health` | Liveness check. Returns 200 with the service version; performs no database read. |
| `GET` | `/ready` | Readiness check. Verifies database connectivity and that the indexer has made progress; returns 503 when the database is unavailable or the indexer has not yet applied any events. |
| `GET` | `/status` | Indexer progress against the chain. Response includes `Cache-Control: no-store` to prevent stale lag readings. |
| `GET` | `/streams` | List streams. Query params: `sender`, `recipient`, `token`, `limit`, `offset`, `includeTotal`, `cancelled`, `cursor`. Address filters accept lowercase and padded spellings and are normalized before matching. `total` is only included when `includeTotal=true`; `cancelled` filters by cancellation status when given, and is omitted to return both. Repeating a parameter is rejected with `400` — see [Query parameters](#query-parameters). |
| `GET` | `/streams/summary` | Aggregate counts and exact total amounts per status (`pending`, `streaming`, `completed`, `cancelled`). Useful for dashboard overview displays without fetching individual streams. Response is cached for 30 seconds. |
| `GET` | `/streams/:id` | A single stream by id. Also available as `HEAD`. |
| `GET` | `/streams/:id/events` | A single stream's indexed event history, in ascending chain order. Optional `kind` filter (`created`, `withdrawn`, `cancelled`). |
| `GET` | `/streams/:id/schedule` | Evenly spaced vesting curve points for charting, with the cliff instant included. Optional `points` query param (2–100, default 50). |
| `GET` | `/accounts/:address/summary` | Incoming and outgoing stream counts and amount totals for a single Stellar address. |
| `GET` | `/tokens` | Each distinct streamed token, with its stream count and total escrowed amount. |
| `GET` | `/metrics` | Prometheus metrics. Set `METRICS_TOKEN` to require `Authorization: Bearer <token>`. |

Each stream is returned with its stored fields plus derived `vested`,
`withdrawable`, `locked`, `progress`, and `status` (`pending`, `streaming`,
`completed`, or `cancelled`). `progress` is vesting progress in basis points
(0–10000).

### Query parameters

Filter parameters are single-valued. Repeating one — `?sender=A&sender=B` — is
rejected with `400 VALIDATION_ERROR` instead of silently keeping the last value,
because a silent last-wins rule hides client mistakes and is a known
parameter-pollution footgun. The same applies when the repeated values are
identical, and when the second spelling is percent-encoded (for example
`?sender=A&%73ender=B`). See
[docs/query-parameters.md](docs/query-parameters.md) for the decision record.

### Example Requests

A copy-paste `curl` call and a trimmed response for every endpoint, against
a local instance on the default port. Amounts (`uint128`) and times and ids
(`uint64`) are always decimal strings, never JSON numbers — see
[Data Types and Precision](#stream-summary-endpoint) below for why.

**`GET /`**
```bash
curl -s http://localhost:3000/ | jq
```
```json
{
  "name": "tricklepay-backend",
  "description": "Indexer and read API for TricklePay token streams",
  "network": "testnet",
  "contractId": "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW",
  "endpoints": [
    { "method": "GET", "path": "/health", "description": "Liveness check" },
    { "method": "GET", "path": "/status", "description": "Indexer progress" },
    { "method": "GET", "path": "/metrics", "description": "Prometheus metrics" },
    { "method": "GET", "path": "/streams", "description": "List streams; filters: sender, recipient, token, limit, offset" },
    { "method": "GET", "path": "/streams/:id", "description": "A single stream by id" }
  ]
}
```

**`GET /health`**
```bash
curl -s http://localhost:3000/health | jq
```
```json
{ "status": "ok", "version": "0.1.0" }
```

**`GET /ready`**
```bash
curl -s http://localhost:3000/ready | jq
```
```json
{ "status": "ready", "database": "up", "indexer": { "lagLedgers": 1234 } }
```

**`GET /status`**
```bash
curl -s http://localhost:3000/status | jq
```
```json
{
  "indexer": {
    "initialized": true,
    "startLedger": 0,
    "lastLedger": 56290013,
    "cursor": "0241763764928512000-0000000001",
    "updatedAt": "2025-11-14T03:00:00.000Z"
  },
  "chain": { "latestLedger": 56999999 },
  "lagLedgers": 709986,
  "failedEventCount": 0
}
```

**`GET /streams`** — list, optionally filtered by `sender`, `recipient`, or `token`
```bash
curl -s "http://localhost:3000/streams?limit=1" | jq
```
```json
{
  "streams": [
    {
      "id": "42",
      "sender": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      "recipient": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      "token": "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
      "totalAmount": "100000000000000",
      "withdrawn": "25000000000000",
      "vested": "50000000000000",
      "withdrawable": "25000000000000",
      "locked": "50000000000000",
      "progress": 5000,
      "startTime": "1735689600",
      "endTime": "1767225600",
      "cliffTime": "1740000000",
      "cancelled": false,
      "status": "streaming",
      "createdLedger": 100,
      "updatedLedger": 200
    }
  ],
  "limit": 1,
  "offset": 0,
  "nextCursor": "eyJzdHJlYW1JZCI6IjQyIn0"
}
```

**`GET /streams/summary`**
```bash
curl -s http://localhost:3000/streams/summary | jq
```
```json
{
  "pending": { "count": 42, "totalAmount": "1000000000000000", "withdrawn": "0" },
  "streaming": { "count": 123, "totalAmount": "5000000000000000", "withdrawn": "1250000000000000" },
  "completed": { "count": 89, "totalAmount": "3000000000000000", "withdrawn": "3000000000000000" },
  "cancelled": { "count": 5, "totalAmount": "250000000000000", "withdrawn": "100000000000000" }
}
```

**`GET /streams/:id`**
```bash
curl -s http://localhost:3000/streams/42 | jq
```
```json
{
  "id": "42",
  "sender": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "recipient": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  "token": "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
  "totalAmount": "100000000000000",
  "withdrawn": "25000000000000",
  "vested": "50000000000000",
  "withdrawable": "25000000000000",
  "locked": "50000000000000",
  "progress": 5000,
  "startTime": "1735689600",
  "endTime": "1767225600",
  "cliffTime": "1740000000",
  "cancelled": false,
  "status": "streaming",
  "createdLedger": 100,
  "updatedLedger": 200
}
```

**`GET /streams/:id/events`**
```bash
curl -s http://localhost:3000/streams/42/events | jq
```
```json
[
  {
    "eventId": "0000000000000000000000000000000000000001-0000000000000001",
    "kind": "created",
    "streamId": "42",
    "ledger": 123456,
    "txHash": "66f7505577a417f4c1187fb8a8eeb6f3737f848d5f0b3b20c5a6c57ab7d659d1",
    "sender": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "recipient": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    "token": "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
    "totalAmount": "100000000000000",
    "amount": null,
    "recipientAmount": null,
    "senderRefund": null,
    "startTime": "1735689600",
    "endTime": "1767225600",
    "cliffTime": "1740000000",
    "closedAt": "1735689600"
  }
]
```

**`GET /streams/:id/schedule`**
```bash
curl -s "http://localhost:3000/streams/42/schedule?points=3" | jq
```
```json
{
  "points": [
    { "time": "1735689600", "amount": "0", "vested": "0" },
    { "time": "1740000000", "amount": "13668188736681", "vested": "13668188736681" },
    { "time": "1767225600", "amount": "100000000000000", "vested": "100000000000000" }
  ]
}
```

**`GET /accounts/:address/summary`**
```bash
curl -s http://localhost:3000/accounts/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/summary | jq
```
```json
{
  "incoming": {
    "count": 3,
    "totalAmount": "100000000000000",
    "total": "100000000000000",
    "withdrawn": "25000000000000",
    "vested": "50000000000000",
    "withdrawable": "25000000000000"
  },
  "outgoing": {
    "count": 1,
    "totalAmount": "40000000000000",
    "total": "40000000000000",
    "withdrawn": "10000000000000",
    "vested": "20000000000000",
    "withdrawable": "10000000000000"
  }
}
```

**`GET /tokens`**
```bash
curl -s http://localhost:3000/tokens | jq
```
```json
[
  {
    "token": "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
    "count": 12,
    "total": "1000000000000000"
  }
]
```

**`GET /metrics`**
```bash
curl -s http://localhost:3000/metrics
```
```text
# HELP tricklepay_indexer_lag_ledgers Gap between the chain's latest ledger and the highest ledger the indexer has applied
# TYPE tricklepay_indexer_lag_ledgers gauge
tricklepay_indexer_lag_ledgers 709986
```

### Pagination Parameters

The `GET /streams` endpoint supports pagination through the following query parameters:

| Parameter | Type | Default | Maximum | Description |
|-----------|------|---------|---------|-------------|
| `limit` | integer | 50 | 100 | Maximum number of streams to return per page |
| `offset` | integer | 0 | 10,000 | Zero-based index of the first stream to return |
| `cursor` | string | - | - | Opaque cursor from a previous response for stable pagination |
| `includeTotal` | boolean | false | - | When `true`, includes the total count of matching streams |

**Note:** When `cursor` is provided, `offset` is ignored and offset ceiling checks are skipped. Use cursor-based pagination for stable results under concurrent inserts.

**Revalidation:** `GET /streams` responses carry a weak `ETag` derived from the response body. Send it back in an `If-None-Match` header to receive `304 Not Modified` with no body when nothing changed, saving bandwidth on repeat polls. The `ETag` changes whenever any returned field changes (streams, `total`, `nextCursor`, or pagination).
| `GET` | `/streams/summary` | Aggregate counts and exact total amounts per status (`pending`, `streaming`, `completed`, `cancelled`). Useful for dashboard overview displays without fetching individual streams. Response is cached for 30 seconds. |
| `GET` | `/streams/:id` | A single stream by id. |
| `GET` | `/metrics` | Prometheus metrics. Set `METRICS_TOKEN` to require `Authorization: Bearer <token>`. |
When `cursor` is provided, `offset` is ignored and the offset ceiling check
below is skipped.

#### offset vs. cursor: why the results can differ

`offset` pages by position — "skip N rows, then take the next `limit`" —
against a list ordered by stream id descending (newest first; see the
`/streams` endpoint description above for the full ordering rule when an
address filter is applied). That position shifts under you if a row is
inserted or removed between requests, because the set of rows that exists
"before" a given position has changed.

Concretely: with streams `101`–`105` already indexed, a client fetches
`?limit=2&offset=0` and gets `[105, 104]` (newest first). Before it asks for
the next page, stream `106` is indexed. The client then fetches
`?limit=2&offset=2`, expecting to continue with `[103, 102]`, but `106` is
now the newest row and has pushed everything down by one position: position 2
is stream `104` again. The response is `[104, 103]` — **`104` is returned
twice, and `106` is never returned at all**, because the client had already
moved past the position it would have appeared in. A deletion between
requests has the opposite effect: everything shifts up by one, and a row gets
skipped instead of repeated.

`cursor` pages by value instead of position: the response's `nextCursor`
encodes the id of the last stream already returned, and the next request
asks for rows strictly before that id (`streamId < cursor`, same descending
order). A newly inserted stream gets a newer id than anything already paged
past, so it never falls inside a window that has already been returned, and a
cancelled or otherwise-unchanged stream never moves relative to the cursor.
Pagination is therefore stable under concurrent inserts, at the cost of not
being able to jump to an arbitrary page — only "next."

**Prefer `cursor` whenever you are paging through more than one page of
results**, especially for a backfill, export, or anything long-running enough
for the table to change underneath it. `offset` is fine for a single page, or
for jumping to a known position (e.g. a UI page number) where occasionally
seeing a duplicate or missing row at the boundary is acceptable.

#### Why offset is capped at 10,000

An `offset` that large forces Postgres to scan and discard that many rows
before it can return the page, which gets slow as the offset grows — exactly
the kind of scan a client doing bulk pagination should not be doing anyway.
Requests with `offset` over 10,000 are rejected with `400 VALIDATION_ERROR`
instead of being served slowly; `cursor`-based pagination has no such ceiling
because it is a keyset lookup (`streamId < cursor`) that stays fast regardless
of how many pages precede it.

#### Following `nextCursor` to fetch every page

```ts
let cursor: string | undefined;
const allStreams = [];

do {
  const url = new URL("http://localhost:3000/streams");
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);

  const page = await fetch(url).then((r) => r.json());
  allStreams.push(...page.streams);
  cursor = page.nextCursor; // undefined once the last page is reached
} while (cursor);
```

`nextCursor` is present only when another page follows; its absence from the
response is the end-of-results signal, not an empty `streams` array (the last
page can still hold up to `limit` rows).

### Stream Summary Endpoint

The `/streams/summary` endpoint returns aggregate counts and exact total amounts grouped by lifecycle status. It is designed for dashboard overview displays where individual stream details are not needed.

**When to use `/streams/summary` instead of `/streams`:**
- Building a dashboard "at a glance" panel showing counts and totals per status
- Displaying aggregate metrics without paginating through individual streams
- Monitoring overall system activity across all indexed streams

**Response format:**
```json
{
  "pending": { "count": 42, "totalAmount": "1000000000000000", "withdrawn": "0" },
  "streaming": { "count": 123, "totalAmount": "5000000000000000", "withdrawn": "1250000000000000" },
  "completed": { "count": 89, "totalAmount": "3000000000000000", "withdrawn": "3000000000000000" },
  "cancelled": { "count": 5, "totalAmount": "250000000000000", "withdrawn": "100000000000000" }
}
```

All amounts are exact integer base units encoded as strings (not JSON numbers) to preserve full 128-bit precision. The response is held in-process for the window set by `STREAM_SUMMARY_CACHE_TTL_MS` (2 seconds by default, `0` to disable); `Cache-Control: public, max-age=N` reports the seconds left in that window, so `N` counts down as the cached entry ages — the full window immediately after a fresh computation, `0` at the end of it — and a client's copy never outlives the server's.

**Data Types and Precision**
- **Amounts** (`totalAmount`, `withdrawn`, `vested`, `withdrawable`, `locked`) are returned as strings holding integer base units.
- **Times** (`startTime`, `endTime`, `cliffTime`) are returned as Unix seconds encoded as strings.

Strings are used rather than JSON numbers to safely preserve full 64-bit and 128-bit integer precision. If they were returned as numbers, clients could silently lose precision when parsing them as IEEE 754 floating-point values.

`/status` reports the indexer's own position and the chain's head as two
separate figures, because only the distance between them means anything:

```json
{
  "indexer": {
    "initialized": true,
    "startLedger": 0,
    "lastLedger": 56290013,
    "cursor": "0241763764928512000-0000000001",
    "updatedAt": "2025-11-14T03:00:00.000Z"
  },
  "chain": { "latestLedger": 56999999 },
  "lagLedgers": 709986,
  "failedEventCount": 0
}
```

**Field reference**

**Cache behaviour**: The `/status` endpoint sets `Cache-Control: no-store` to prevent stale readings. Clients polling for indexer progress should fetch fresh data on every request; intermediate proxies and CDNs are instructed not to cache the response.

| Field | Type | Description |
| --- | --- | --- |
| `indexer.initialized` | boolean | `true` once the indexer has completed its first poll and recorded a position. `false` before that — the API returns zeros for the other fields in this state. |
| `indexer.lastLedger` | number | Highest ledger sequence whose events have been fully applied to the database. Only advances when an event is actually written; a poll that finds no events leaves it unchanged. |
| `indexer.cursor` | string \| null | Opaque Soroban RPC paging token. The indexer resumes from this token on the next poll. Advances on every poll — including empty ones — so it must not be compared to the chain head to derive lag. `null` before the first poll. |
| `indexer.updatedAt` | string \| null | ISO-8601 timestamp of when the position was last written. A lag that stops growing combined with a stale `updatedAt` indicates a stalled indexer; a growing `updatedAt` with a steady lag indicates a caught-up indexer on a quiet chain. `null` before the first poll. |
| `chain.latestLedger` | number | The chain's head ledger as of the indexer's last completed poll. The API never queries the chain directly — this value is read from Postgres, where the poller stored it. |
| `lagLedgers` | number \| null | `chain.latestLedger - indexer.lastLedger`. The number of ledgers between the chain head and the indexer's position. `null` before the first poll. Never negative. |
| `failedEventCount` | number | Count of contract events that could not be applied and remain in the `FailedEvent` table. A non-zero value signals events that need operator attention or replay (see [Failed-event replay](#failed-event-replay)). |

**What `lagLedgers` is**

`lagLedgers` is the *gap since the last processed event* — the distance between the chain's head and the highest ledger the indexer actually applied. It tells you how far the indexer's mirror is behind the chain as of the last poll.

**What `lagLedgers` is not**

It is *not* a measure of indexing delay or processing latency. A chain that has produced no new events since the last poll still reports a non-zero lag if the indexer started from an older ledger. Conversely, a freshly started indexer that has caught up to the head will report zero lag even if the poll took several seconds. The figure only changes when either the chain produces a new ledger or the indexer applies an event — it is a positional gap, not a time-based metric.

Both figures are as of the last completed poll — the API never queries the chain — and `updatedAt` says when that was, which is how a stalled indexer, whose lag stops growing, is told apart from one that is genuinely level. `lagLedgers` is null until the first poll has recorded something to measure.

## Error Responses

All error responses follow a consistent JSON shape:

```json
{
  "code": "VALIDATION_ERROR",
  "error": "invalid stream id",
  "requestId": "req-1"
}
```

### Error Fields

| Field | Type | Description |
|-------|------|-------------|
| `code` | string | Machine-readable error category |
| `error` | string | Human-readable error message |
| `requestId` | string | Request id from `x-request-id` header, for matching to server logs |

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid input parameters or malformed request |
| `NOT_FOUND` | 404 | Requested resource does not exist |
| `REQUEST_ERROR` | 400 | General client-side request error |
| `INTERNAL_SERVER_ERROR` | 500 | Server-side failure (see server logs with requestId) |

### Example Error

```bash
curl -s http://localhost:3000/streams/invalid | jq
```

```json
{
  "code": "VALIDATION_ERROR",
  "error": "invalid stream id",
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

## Health Endpoint Semantics

`/health` is a liveness probe: it returns 200 with the service version and
performs no database read, so it stays green even when dependencies are down.

`/ready` is a readiness probe and reflects whether the service has usable
data, not merely whether dependencies answer. It verifies database
connectivity and that the indexer has made progress — specifically, that
`IndexerState.lastLedger` has advanced past its initial value, meaning at
least one event has been applied to Postgres. A freshly started instance that
has not yet indexed anything returns 503, so traffic is not routed to an
instance that would serve an empty list. Liveness is unaffected: `/health`
continues to return 200 regardless of indexer progress.

The service exposes two health endpoints that answer different questions. Wire them to separate probes in your orchestration platform.

### Liveness — `GET /health`

**What it checks:** Whether the Node.js process is running and responsive.

**What it deliberately does NOT check:**
- Database connectivity
- Indexer status
- Chain connectivity
- Any external dependency

**Response:**
```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

**Intended use:** This is a **liveness probe**. Use it to detect when the process itself is wedged (e.g., deadlocked, crashed, or otherwise unresponsive). If this endpoint stops responding, your orchestration platform should restart the container. The endpoint performs no I/O — it returns immediately from memory — so it stays green even when the database is unreachable or the chain is down.

### Readiness — `GET /ready`

**What it checks:**
1. Database connectivity (can reach Postgres)
2. Indexer lag (how far behind the chain)

**What it does NOT check:**
- Chain connectivity
- Whether the indexer is currently running

**Response (healthy):**
```json
{
  "status": "ready",
  "database": "up",
  "indexer": {
    "lagLedgers": 1234
  }
}
```

**Response (unhealthy):**
```json
{
  "status": "not_ready",
  "database": "down",
  "error": "Connection refused"
}
```

Every 503 response also carries a `Retry-After` header whose value is the number of seconds to wait before probing again, so orchestrators and load balancers can pace their checks — for example while a long backfill is still running. The value defaults to 5 seconds and is configurable via `READINESS_RETRY_AFTER_SECONDS`. A ready (200) response does not include the header.

**Intended use:** This is a **readiness probe**. Use it to determine whether the instance should receive traffic. If this returns 503, take the instance out of load-balancer rotation — the process is fine, but a dependency isn't. Do NOT restart the container on a readiness failure; wait for the dependency to recover.

### Why Separate Probes?

| Probe | Fires When | Action |
|-------|------------|--------|
| Liveness (`/health`) | Process is unresponsive | Restart container |
| Readiness (`/ready`) | Database unreachable | Remove from rotation, do not restart |

## Metrics

The service exposes Prometheus metrics at `/metrics`. Scrape this endpoint from a Prometheus instance or a compatible collector (Grafana Alloy, Victoria Metrics, etc.).

### Indexer Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `tricklepay_indexer_events_applied` | Counter | `kind`, `outcome` | Total contract events applied to the database |
| `tricklepay_indexer_pages_fetched` | Counter | — | Total event pages fetched from the Soroban RPC |
| `tricklepay_rpc_errors` | Counter | `operation` | Total Soroban RPC calls that resulted in an error |
| `tricklepay_indexer_poll_errors` | Counter | — | Total poll iterations that failed with an unhandled error |
| `tricklepay_indexer_poll_success_total` | Counter | — | Total successful indexer poll iterations |
| `tricklepay_indexer_events_failed` | Counter | `kind` | Total individual events that failed to apply and were skipped |
| `tricklepay_indexer_lag_ledgers` | Gauge | — | Gap between the chain's latest ledger and the highest ledger the indexer has applied (-1 before first poll) |
| `tricklepay_indexer_poll_last_success_timestamp_seconds` | Gauge | — | Unix timestamp of the last successful poll (0 before first success) |

### HTTP Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `tricklepay_http_requests_total` | Counter | `method`, `route`, `status` | Total HTTP requests handled |
| `tricklepay_http_request_duration_ms` | Histogram | `method`, `route`, `status` | HTTP request duration in milliseconds (buckets: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000) |

### Example PromQL Queries

**Poll throughput:**
```promql
rate(tricklepay_indexer_poll_success_total[5m])
```

**Stalled poller alert (no successful poll in 5 minutes):**
```promql
tricklepay_indexer_poll_last_success_timestamp_seconds < time() - 300
```

**HTTP request error rate:**
```promql
sum(rate(tricklepay_http_requests_total{status=~"5.."}[5m])) / sum(rate(tricklepay_http_requests_total[5m]))
```

## Running locally

Requires **Node.js 20.12 or later**, Docker, and the deployed contract id. The minimum is Node 20.12 because the service uses the built-in `node:` protocol imports and native fetch, which are only fully stable from that release onward — older versions will fail at install or startup. The `engines.node` field in [package.json](package.json) encodes this requirement (`>=20.12`), and the repository also includes a `.nvmrc` pinned to `20.12.0` so `nvm use` drops you onto the right version automatically. Production runs on a newer Node than this floor; see [docs/node-version-policy.md](docs/node-version-policy.md) for the minimum, tested, and production versions and why they differ.

```bash
nvm use
cp .env.example .env        # then set STREAM_CONTRACT_ID
npm install
./scripts/dev.sh            # starts Postgres, syncs schema, runs with reload
```

### Running with Docker Compose

For the image contents, runtime user, entrypoint, and exposed port, see
[docs/container-image.md](docs/container-image.md).

The repository includes a multi-container setup in `docker-compose.yml` that starts both the PostgreSQL database and the API service (which automatically runs pending database migrations on startup).

#### Environment Variables for Docker

When running with Docker Compose, the service requires or configures the following environment variables:

| Variable | Required | Description / Default |
| --- | --- | --- |
| `STREAM_CONTRACT_ID` | **Yes** | Deployed Soroban contract address (56 characters starting with `C`). Must be provided in `.env` or set in shell environment. |
| `DATABASE_URL` | Yes | Pre-configured in compose to `postgresql://tricklepay:tricklepay@postgres:5432/tricklepay`. |
| `NETWORK` | No | Stellar network (`testnet` or `mainnet`). Default in compose: `testnet`. |
| `PORT` | No | Container HTTP listen port. Default: `3000`. |
| `HOST` | No | Container listen address. Default: `0.0.0.0`. |

#### Step-by-Step Instructions from a Clean Checkout

1. **Clone the repository and prepare environment configuration:**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set `STREAM_CONTRACT_ID` to your deployed stream contract address (e.g., `STREAM_CONTRACT_ID=C...`).

2. **Start the database and API containers:**

   ```bash
   docker compose up --build
   ```

   To run the stack in detached (background) mode, use:

   ```bash
   docker compose up -d
   ```

   The `api` container waits for the `postgres` healthcheck to pass, runs `npx prisma migrate deploy` automatically, and then starts the API service.

3. **Verify and view logs:**

   ```bash
   docker compose logs -f api
   ```

   The API endpoint will be available at `http://localhost:3000`.

4. **Stop the stack:**

   ```bash
   docker compose down
   ```

   To stop the stack and delete the persistent PostgreSQL volume (`pgdata`), pass the `-v` flag:

   ```bash
   docker compose down -v
   ```

#### Building and Running with Standalone Docker

If you already have a PostgreSQL instance running, you can build and run the backend image directly:

```bash
# Build the Docker image
docker build -t tricklepay-backend .

# Run the container
docker run -d \
  --name tricklepay-api \
  -e DATABASE_URL="postgresql://tricklepay:tricklepay@host.docker.internal:5432/tricklepay" \
  -e STREAM_CONTRACT_ID="C..." \
  -p 3000:3000 \
  tricklepay-backend
```

The API listens on `http://localhost:3000`.
For instructions on pointing the indexer and API to a standalone or containerized local Soroban RPC node, see [Running Against a Local Network](docs/local-network.md).

#### Test database (for integration tests)

The integration suite (`npm run test:integration`) needs a real Postgres
instance, and pointing it at the same database as development risks wiping
local data (`beforeAll` clears the `Stream` table before the suite runs).
`docker-compose.yml` includes an opt-in `postgres-test` service, kept out of
the default `docker compose up` by a `test` profile, with its own container
name, port (`5433`, not `5432`) and volume (`pgdata-test`, not `pgdata`), so
it can never collide with or be mistaken for the development database:

```bash
docker compose --profile test up -d postgres-test
DATABASE_URL=postgresql://tricklepay_test:tricklepay_test@localhost:5433/tricklepay_test \
  npx prisma migrate deploy
DATABASE_URL=postgresql://tricklepay_test:tricklepay_test@localhost:5433/tricklepay_test \
  npx vitest run --project integration
```

Stop it independently of the development database with:

```bash
docker compose --profile test down -v   # -v also drops the pgdata-test volume
```

## Failed events table

The `FailedEvent` table is the indexer's operator-facing safety net. When an
individual event cannot be decoded or applied, the poller records a row so the
rest of the page can continue without stopping indexing. Each row stores:

- `eventId`: the Soroban RPC `TOID-index` that uniquely identifies the event
- `kind`: the decoded event kind, or `"unknown"` if decoding failed first
- `streamId`: the target stream, when available, encoded as a string
- `ledger`: the ledger in which the event was observed
- `txHash`: the transaction hash when available; null for older rows or unavailable hashes
- `error`: the most recent exception text from the failed attempt
- `failureCount`: how many times this event has failed
- `firstFailedAt` / `lastFailedAt`: timestamps for the first and latest failure

The row is upserted on each failure, so repeated attempts refresh the error and
increment `failureCount` without creating duplicate rows. A successful replay or a
subsequent clean apply clears the record.

### Inspecting failed events

You can inspect the table directly with PostgreSQL or by using the built-in
replay command as a dry run:

```bash
# see the oldest unresolved failures first
psql "$DATABASE_URL" -c 'SELECT "eventId", "kind", "streamId", "ledger", "txHash", "failureCount", "error" FROM "FailedEvent" ORDER BY "ledger" ASC LIMIT 20;'

# count unresolved failures
psql "$DATABASE_URL" -c 'SELECT COUNT(*) FROM "FailedEvent";'

# preview the next 20 failed rows without changing state
npm run replay-failed-events -- --dry-run --limit 20
```

The SQL view is useful when you need to trace the exact failed event, ledger,
and exception text. The replay command is useful when you want a bounded retry
without waiting for a full poller sweep.

### Cursor behavior on a failed event

When a single event fails, the indexer does not stop the page or rewind the
cursor. It logs the error, records the failed row, and continues processing the
remaining events in the same page. The cursor is saved only after the page is
finished and `saveIndexerPosition` runs, so the next poll resumes from the page's
cursor rather than from the bad event itself.

`lastLedger` is advanced only after a successful apply, which means a failed
event never counts as processed. In other words, one bad event is skipped, the
cursor still advances past that page, and the indexer continues without being
left stranded behind a single invalid record.

## Failed-event replay

Failed events are stored in the database with their event id, ledger, kind, and
most recent error. Operators can retry a bounded batch without waiting for a
full poller sweep:

```bash
# inspect the next 20 failed rows without changing state
npm run replay-failed-events -- --dry-run --limit 20

# retry the next 20 rows and clear any that apply cleanly
npm run replay-failed-events -- --limit 20
```

The command replays failed rows in `ledger` order, resolves the matching RPC
contract event for each row, retries it independently, clears the record when
it succeeds, and keeps the retry set bounded so one permanently invalid event
cannot stall the rest.

## Contributing

For instructions on setting up your local environment, running required checks (`./scripts/check.sh`), and submitting pull requests, see [CONTRIBUTING.md](CONTRIBUTING.md).

Before opening a pull request, run the local checks script to ensure everything passes:

```bash
./scripts/check.sh
```
This script runs the typecheck, tests, and build in order. It will exit non-zero on the first failure.

For global contributor guidelines across the organization, refer to the shared [TricklePay Documentation Guide](https://github.com/TricklePay/tricklepay-docs).

All contributors are expected to adhere to the project's [Code of Conduct](CODE_OF_CONDUCT.md).

### Import ordering

Keep import blocks in one canonical order across the source and tests so file edits do not create noisy diffs:

- Node built-ins first, such as `node:*`.
- Third-party packages next, alphabetized by package name.
- Relative imports last, alphabetized by path (`./...` before `../...`).
- Keep one blank line between groups and no extra empty lines inside a block.

This convention applies to both application code and tests.

## Testing

Unit tests run under [Vitest](https://vitest.dev) and need neither a database
nor a network connection:

```bash
npm test          # single run, as CI does it
npm run test:watch
```

The integration suite (`npm run test:integration`) is opt-in and needs a real
Postgres database; see [Test database (for integration
tests)](#test-database-for-integration-tests) for how to start one without
touching development data.

### Unused dependency check

Run `npm run depcheck` to scan for dependencies that are not imported anywhere in the codebase. This helps keep the dependency tree lean and reduces install time and audit surface.

```bash
npm run depcheck
```

The command uses [depcheck](https://github.com/depcheck/depcheck) and reports both unused dependencies and missing dependencies (imports that are not declared in package.json). Address any findings by either removing the unused dependency or adding the missing one.

They cover the parts of the service that have to agree with something outside
it: `lib/vesting.ts`, which mirrors the contract's vesting math case for case,
and `chain/events.ts`, which is decoded from a stored Soroban RPC `getEvents`
response — see [tests/fixtures/](tests/fixtures/README.md) for its provenance
and how to refresh it. They also cover what the indexer reports about itself,
since a progress figure that is wrong is worse than none: `indexer/poller.ts`
for which ledger a poll records as reached, and `routes/status.ts` for the lag
derived from it. `npm run typecheck` covers the tests as well as `src`.

**Running a single file or test**

Pass a file path to run only that file, and `-t` to further filter by test name
(substring or regex matched against the full test title):

```bash
# run one file
npx vitest run --project unit tests/lib/vesting.test.ts

# run tests whose name contains "cliff"
npx vitest run --project unit tests/lib/vesting.test.ts -t "cliff"

# watch a single file while iterating
npx vitest --project unit tests/lib/vesting.test.ts
```

The `--project unit` flag is required when targeting a specific file because
the config defines named projects; omitting it makes Vitest search across all
projects and may produce unexpected results.

## Configuration

All configuration is read from the environment; `.env.example` is the complete,
current template — copy it and fill in the required values.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | **Yes** | - | Postgres connection string. |
| `STREAM_CONTRACT_ID` | **Yes** | - | Deployed Soroban contract address. |
| `NETWORK` | No | `testnet` | Stellar network (`testnet` or `mainnet`). |
| `SOROBAN_RPC_URL` | No | *network dependent* | Soroban RPC endpoint. Defaults to the public endpoint for the selected network. Plain `http://` is only accepted for `localhost`, `127.0.0.0/8`, or `::1`/`[::1]`; any other host must use `https://` or startup fails — see [Plain HTTP is only allowed for local RPC hosts](docs/local-network.md#plain-http-is-only-allowed-for-local-rpc-hosts). |
| `PORT` | No | `3000` | HTTP server listen port. |
| `HOST` | No | `0.0.0.0` | HTTP server bind address. |
| `CORS_ORIGIN` | No | - | Allowed browser origin for the web client. |
| `PUBLIC_BASE_URL` | No | `http://<HOST>:<PORT>` | Base URL advertised in the generated OpenAPI document's `servers` entry. Defaults to a URL derived from `HOST` and `PORT`. |
| `LOG_LEVEL` | No | `info` | Log verbosity (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`). |
| `LOG_PRETTY` | No | - | Set to `true` for human-readable development logs; requires the `pino-pretty` dev dependency. Output stays JSON when unset. |
| `BODY_LIMIT` | No | `1048576` | Largest accepted request body in bytes. |
| `QUERY_STRING_LIMIT` | No | `2048` | Longest accepted URL query string in bytes. |
| `ENABLE_DOCS_UI` | No | `true` | Serve the interactive Swagger UI at `/docs`. Set to `false` to disable the page and its static assets while `/docs/json` and `/docs/yaml` stay available. Accepts `true/false` (also `1/0`, `yes/no`, `on/off`); anything else fails startup. |
| `METRICS_TOKEN` | No | - | Bearer token required on `/metrics` when set; unset keeps the endpoint unauthenticated. Only send it over TLS and keep the recommended network restriction. |
| `COMPRESSION_THRESHOLD_BYTES` | No | `1024` | Responses at least this many bytes are compressed when the client accepts `gzip` or `br`. Smaller responses are sent uncompressed. |
| `RATE_LIMIT_MAX` | No | `100` | Maximum requests per client IP in each rate-limit window. Must be greater than zero. |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Length of the fixed rate-limit window in milliseconds. Must be greater than zero. |
| `TRUSTED_PROXIES` | No | - | Comma-separated list of trusted reverse-proxy addresses or IPv4 CIDR blocks. Forwarded headers are ignored when unset. |
| `READINESS_RETRY_AFTER_SECONDS` | No | `5` | Seconds advertised in the `Retry-After` header when `GET /ready` returns 503, so orchestrators and load balancers know when to probe again. |
| `INDEXER_POLL_INTERVAL_MS` | No | `5000` | Milliseconds between polls of the chain. |
| `INDEXER_BACKOFF_MAX_MS` | No | `60000` | Maximum poll retry delay (ms) on RPC failures. |
| `INDEXER_START_LEDGER` | No | `0` | Ledger to begin indexing from. `0` starts at the chain's latest ledger. |
| `INDEXER_MAX_PAGES_PER_TICK` | No | `1000` | Maximum number of event pages fetched per poll tick. |
| `STREAM_SUMMARY_CACHE_TTL_MS` | No | `2000` | Summary endpoint cache window in milliseconds. Set to `0` to disable caching. |

### Switching to a different contract

`STREAM_CONTRACT_ID` and `INDEXER_START_LEDGER` must be changed together, and
the previous contract's indexed state must be cleared. Skipping either step
leaves the service serving stale or mismatched data.

**Why both variables change together:** The indexer resumes from its saved
cursor on every restart, not from `INDEXER_START_LEDGER` (that value only
applies when there is no saved position at all, see
[`IndexerState`](#database-schema)). Changing only `STREAM_CONTRACT_ID` while
a cursor from the old contract is still saved makes the indexer resume at the
old contract's ledger position and poll the new contract's RPC for events at
that position, which is very unlikely to make sense: the new contract was
most likely deployed at a different, usually later, ledger, and its events
start from there.

**Why the previous contract's indexed state must be cleared:** `Stream`,
`IndexedEvent`, and `FailedEvent` all hold rows keyed by data from the old
contract (`streamId`, `eventId`) with no column recording which contract they
came from. Leaving them in place after switching means `/streams` and the
summary endpoint keep serving the old contract's streams alongside (or
instead of, depending on ID collisions) the new contract's, and the old
contract's unresolved `FailedEvent` rows keep showing up in
[failed-event replay](#failed-event-replay) for a contract the service no
longer indexes.

**Steps:**

1. Stop the service, or at minimum stop the indexer poller, so nothing writes
   new rows while you clear the old contract's state.
2. Clear the previously indexed state. Unlike
   [resetting the local database](#resetting-the-local-database), this must
   preserve the Prisma migration history. From a machine with `DATABASE_URL`
   set to the target database:
   ```bash
   echo 'TRUNCATE TABLE "Stream", "IndexedEvent", "FailedEvent", "IndexerState";' | \
     npx prisma db execute --schema prisma/schema.prisma --stdin
   ```
   `IndexerState` is included because its saved cursor and ledger position
   belong to the old contract; truncating it is what makes
   `INDEXER_START_LEDGER` take effect again on the next startup, per the
   explanation above.
3. Set `STREAM_CONTRACT_ID` to the new contract's address (56 characters,
   starting with `C`).
4. Choose `INDEXER_START_LEDGER`:
   - If you know the ledger the new contract was deployed or initialized at,
     use that ledger (or slightly before it, to be safe against an
     off-by-one). Starting earlier than necessary only costs extra RPC calls
     during backfill; starting later risks silently skipping real events.
   - If you don't know it, use `0`, which starts indexing from the chain's
     current latest ledger. This misses any events the new contract already
     emitted before the switch (acceptable when switching to a freshly
     deployed contract with no prior history; not appropriate when migrating
     onto a contract that already has activity you need indexed).
   - The service validates this at startup and refuses to start if
     `INDEXER_START_LEDGER` is beyond the chain's current head, since no
     event could ever satisfy that position (see [index.ts](src/index.ts)).
5. Restart the service.

### Printing the effective configuration

Diagnosing a configuration problem means reasoning about defaults and
precedence across the table above. `npm run print-config` resolves the same
`Config` the server would load and prints it as JSON, in the current
environment, without starting the server:

```
npm run print-config
```

`databaseUrl` is redacted (`"[redacted]"`) whenever it carries embedded
credentials (`postgresql://user:pass@host/db`), so the output is safe to
paste into a bug report or a chat message. A connection string with no
embedded credentials is printed as-is.

### Trusted proxies

Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) are honoured only
when the direct connection peer is an explicitly trusted proxy. Set
`TRUSTED_PROXIES` to a comma-separated list of the proxies that sit in front of
the service, each entry either a bare IP address or an IPv4 CIDR block:

```
TRUSTED_PROXIES=10.0.0.1,10.0.0.2,192.168.0.0/24
```

- A bare address matches a single peer exactly, e.g. `10.0.0.1`.
- A CIDR block matches a range of IPv4 peers, e.g. `192.168.0.0/24`. The prefix
  must be between 0 and 32; IPv6 CIDR blocks are not accepted.
- Entries are validated at startup. An entry that is not a valid IP address or
  IPv4 CIDR block aborts the process rather than silently widening or
  disabling trust, so a typo is caught before the service accepts traffic.

When `TRUSTED_PROXIES` is unset (or empty), **no** proxy is trusted: forwarded
headers are ignored and the socket's peer address is used as the client
address. A direct client therefore cannot spoof the address recorded in logs
and request metadata. Behind a load balancer or ingress that terminates
connections, set this to that proxy's address so the original client address
is preserved.

### Logging

All log output is **structured JSON** using [pino](https://getpino.io). Every
line is a single JSON object — one log event per line — making it easy to
forward to any log aggregator (Datadog, Loki, CloudWatch Logs, etc.) without a
parsing step.

**Fields present on every line**

| Field | Type | Description |
| --- | --- | --- |
| `level` | number | Pino numeric level: `10` trace · `20` debug · `30` info · `40` warn · `50` error · `60` fatal |
| `time` | number | Unix timestamp in milliseconds |
| `pid` | number | Process id |
| `hostname` | string | Machine hostname |
| `msg` | string | Human-readable log message |

**Additional context fields**

- `module` — present on every line emitted by the indexer (`"indexer"`), added
  via a pino child logger so indexer output can be filtered or routed separately.
- `reqId` — present on every Fastify request log line; derived from the
  incoming `X-Request-Id` header when present, otherwise a generated UUID.
- Other fields (e.g. `err`, `signal`, `ledger`, `eventId`) are attached
  ad-hoc to individual lines and document the event's context.

**Log levels**

The valid values for `LOG_LEVEL` are `trace`, `debug`, `info`, `warn`,
`error`, `fatal`, and `silent`; the spelling is case-insensitive, and any
other value is rejected at startup with an error that names the variable and
lists these levels. The default is `info`, which logs normal operational
events — server start, poll ticks, and stream writes — without the
high-frequency trace output. Use `debug` or `trace` in development when
tracing a specific behaviour:

```bash
LOG_LEVEL=debug ./scripts/dev.sh
# or, for a one-off run:
LOG_LEVEL=trace npm start
```

**Example line**

```json
{"level":30,"time":1731550800123,"pid":42,"hostname":"worker-1","module":"indexer","msg":"poll complete","lastLedger":56290013,"newEvents":3}
```

**Startup configuration line**

The resolved configuration comes from three places — the defaults in
`src/config.ts`, a `.env` file, and the ambient environment — so the process
logs what it actually started with as its first line, before anything that
depends on those values can fail:

```json
{"level":30,"time":1731550800001,"pid":42,"hostname":"worker-1","msg":"effective configuration","config":{"port":3000,"host":"0.0.0.0","databaseUrl":"postgresql://***:***@db.internal:5432/tricklepay?schema=public","network":"testnet","networkPassphrase":"Test SDF Network ; September 2015","rpcUrl":"https://soroban-testnet.stellar.org","contractId":"CDMB6…","pollIntervalMs":5000,"startLedger":0,"maxBackoffMs":60000,"maxPagesPerTick":1000,"bodyLimit":1048576,"queryStringLimit":2048,"trustedProxies":[]}}
```

Every field of the `Config` type appears. `DATABASE_URL` is the only one
carrying a secret: its user and password are replaced with `***`, leaving the
host, port, database, and parameters, which are what identify the database the
service is pointed at. A value that cannot be parsed as a URL is logged as
`[unparseable, redacted]`, since there is no way to tell which part of it is
the credential.

**Readable logs in development**

Newline-delimited JSON is what a log shipper wants, not what a developer wants
to read. Set `LOG_PRETTY=true` to route the same records through
[`pino-pretty`](https://github.com/pinojs/pino-pretty) instead:

```bash
LOG_PRETTY=true npm run dev
```

```text
[12:40:00.123] INFO: poll complete
    module: "indexer"
    lastLedger: 56290013
    newEvents: 3
```

`pino-pretty` is a dev dependency, so it is absent from a production install
(`npm ci --omit=dev`, the Docker image). Nothing changes there unless the
variable is set: when it is set and the package cannot be found, the service
logs a warning naming `LOG_PRETTY` and keeps emitting JSON rather than failing
to start.

### Metrics & alerting

The indexer exposes Prometheus metrics at `/metrics`. To tell a quiet chain
(still polling successfully) from a stalled poller (no successful poll), watch
the poll heartbeat:

- `tricklepay_indexer_poll_success_total` — number of successful poll iterations.
- `tricklepay_indexer_poll_last_success_timestamp_seconds` — Unix timestamp (seconds) of the last successful poll; `0` before the first one.

Example alert — fire when the poller has not completed a successful poll in five
minutes (a stalled poller), while a quiet chain keeps ticking and never trips it:

```promql
tricklepay_indexer_poll_last_success_timestamp_seconds < time() - 300
```

Poll throughput can be graphed with:

```promql
rate(tricklepay_indexer_poll_success_total[5m])
```


## Deployment

The same image runs on any container platform; only the environment differs.
Everything in [Configuration](#configuration) applies unchanged — set
`DATABASE_URL` and `STREAM_CONTRACT_ID` at minimum. Treat every value below as
a placeholder to replace, never as a literal to ship with:

```
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
STREAM_CONTRACT_ID=<deployed-contract-id>
NETWORK=mainnet
CORS_ORIGIN=https://<frontend-host>
```

### Concurrency

By design, **only one indexer instance may run against a single database at a time**. The indexer is a singleton service that maintains its own cursor state in the database.
If you run multiple indexer processes pointing to the same database, they will share the same cursor and concurrently fetch and apply the same events. Because the poller applies events idempotently by ID but relies on linear progression, concurrent pollers will double-apply events, overwrite each other's progress records, and severely corrupt the indexer state.

Scaling the read API separately from the indexer is currently not supported out of the box, as the service runs both halves in a single process. To scale the read API horizontally in the future, the application would need an environment flag to disable the poller on replica instances.

### Probes

The service exposes two separate checks; wire them to separate probes, since
they answer different questions:

- **Liveness — `GET /health`.** Returns `200 {"status":"ok","version":...}` as
  soon as the process is up and performs no database read. A liveness probe
  should restart the container if this stops responding — it means the process
  itself is wedged.
- **Readiness — `GET /ready`.** Checks the database connection and returns
  `200` with the current indexer lag when it succeeds, or
  `503 {"status":"not_ready","database":"down"}` when Postgres is unreachable.
  The 503 carries a `Retry-After` header (seconds, configurable via
  `READINESS_RETRY_AFTER_SECONDS`) so probes can pace themselves; a 200 does
  not. A readiness probe should take the instance out of load-balancer rotation
  on a 503 without restarting it — the process is fine, a dependency isn't.

### Migrations

Apply pending Prisma migrations before the process starts serving traffic —
`npx prisma migrate deploy`, never `prisma migrate dev`, which is interactive.
`docker-compose.yml` shows the pattern: the migration runs as a startup step
ahead of `node dist/index.js`, in the same container command. On a platform
with a dedicated pre-deploy hook or init-container step, use that instead of
chaining commands; either way, migrations must complete before the app process
accepts connections.

### Resetting the local database

This is for local development only. Resetting the database permanently deletes
all indexed stream data, application state, and any local PostgreSQL data in the
project's development environment. There is no recovery step in the app itself.

If the local stack is already running, use this to clear the database without
removing the containers:

```bash
docker compose exec postgres psql -U tricklepay -d tricklepay -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker compose exec api npx prisma migrate deploy
```

This drops the existing schema and then applies the Prisma migrations again,
leaving the database empty and ready for a fresh local run.

If you want to recreate the entire local environment from scratch instead, run:

```bash
docker compose down -v
docker compose up -d
```

The `-v` flag removes the named PostgreSQL volume, so all local data is wiped.
After startup, the API's container command runs `npx prisma migrate deploy`
automatically before starting the app.

### Graceful termination

On `SIGTERM` or `SIGINT` the process shuts down in a fixed order
([index.ts](src/index.ts)): it stops the indexer poller first (no new poll
ticks start), then closes the HTTP server (Fastify stops accepting new
connections and waits for in-flight requests to finish), then drains the
Postgres connection pool, then exits `0`. Give the platform's termination
grace period enough headroom for in-flight requests to finish — the process
does not force-exit early on its own. For a detailed rationale of the shutdown sequence, see [Shutdown Ordering and Rationale](docs/shutdown-ordering.md).

## Project structure

The `src/` directory is split across several modules:

- **`chain/`**: Soroban RPC integration, decoding contract events, and querying on-chain state.
- **`indexer/`**: Polling the blockchain and applying streamed events to the database.
- **`lib/`**: Shared utilities and domain logic like vesting math.
- **`repositories/`**: Database access layer for reading and writing models. See [Contributing Guide](CONTRIBUTING.md) for repository conventions.
- **`routes/`**: HTTP API endpoints served by Fastify. See [Request Lifecycle](docs/request-lifecycle.md) and [Endpoint Failure Modes](docs/endpoint-failure-modes.md).

```
src/
  config.ts           environment loading and validation
  logger.ts           shared structured logger
  db.ts               Prisma client singleton
  server.ts           Fastify instance and health route
  index.ts            bootstrap: start API and indexer together
  chain/
    rpc.ts            Soroban RPC client and event fetcher
    events.ts         decode contract events from ScVal
    contract.ts       read full stream state via get_stream, to reconcile
  indexer/
    apply.ts          apply a decoded event to the database
    poller.ts         poll loop with cursor persistence
  repositories/
    streams.ts        stream upserts and queries
    indexer-state.ts  indexer position and cursor bookkeeping
  lib/
    vesting.ts        linear vesting math, mirroring the contract
  routes/
    streams.ts        GET /streams and GET /streams/:id
    status.ts         GET /status: indexer position against chain head
tests/
  lib/
    vesting.test.ts   vesting math, mirroring the contract's Rust tests
  chain/
    events.test.ts    event decoding against captured RPC payloads
  indexer/
    poller.test.ts    which ledger a poll records as reached
  routes/
    status.test.ts    reported progress and lag
    apply.test.ts     event to database write routing, with no chain calls
  fixtures/
    get-events.json   a Soroban RPC getEvents response, as the RPC returns it
prisma/
  schema.prisma       Stream and IndexerState models
```

## Frequently asked questions

**Why does this service exist — can't a client just query the contract directly?**

Querying the contract directly requires an RPC simulation for every field read,
which is slow and puts load on public RPC endpoints. This service mirrors all
stream state to Postgres so the [API](#api) can serve reads in a single
database query. Derived fields like `vested`, `withdrawable`, and `progress`
are computed on every request against the current clock, so they are always
up to date without any chain round-trip. See [How it works](#how-it-works) for
the full picture.

**What happens when the indexer falls behind the chain?**

It catches up automatically. The poller resumes from its saved cursor on every
tick, fetching up to `INDEXER_MAX_PAGES_PER_TICK` pages before yielding so
a deep backlog is spread across ticks rather than blocking indefinitely. While
the indexer is behind, stored fields like `withdrawn` and `cancelled` reflect
the last applied event, but the derived fields `vested` and `progress` still
track wall-clock time accurately. You can monitor the gap with `/status`, which
reports `lagLedgers` as `chainLedger - lastLedger`. See
[Configuration](#configuration) and [API](#api) for the relevant knobs and
endpoints.

**How do I know if the indexer is stalled versus just on a quiet part of the chain?**

Check the Prometheus metrics. `tricklepay_indexer_poll_last_success_timestamp_seconds`
records when the last successful poll completed; if that timestamp stops
advancing, the poller itself is stuck. A quiet chain still produces successful
polls and keeps that timestamp current, so it never trips a stale-poller alert.
The ready example alert and metric queries are in
[Metrics & alerting](#metrics--alerting).

**Why are amounts and timestamps returned as strings instead of numbers?**

Stellar amounts are 64-bit integers and some internal values are 128-bit.
JSON numbers are IEEE 754 doubles, which can only represent integers exactly up
to 2^53. Returning large values as numbers would silently corrupt them in any
client that parses standard JSON. Strings preserve the full value without
requiring a special parser. See [API](#api) under **Data Types and Precision**.

**What does it mean when an event ends up in the `FailedEvent` table, and how do I recover?**

The indexer writes a row to `FailedEvent` whenever it cannot apply a contract
event — for example, due to a transient database error or an unexpected event
shape. Those rows are kept so nothing is silently dropped, and they can be
retried without a full re-index using the `replay-failed-events` command
described in [Failed-event replay](#failed-event-replay). For how long to keep
those rows and how to prune them on a long-running instance, see
[docs/failed-events-retention.md](docs/failed-events-retention.md).

**Is it safe to restart the service mid-backfill?**

Yes. The poller saves its cursor after every page of events, so a restart picks
up from the last saved cursor rather than the beginning. Event application is
idempotent — replaying a page that was already applied changes nothing, because
`Created` only inserts a stream that is absent and each delta only applies when
the row's last-event id predates it. See [How it works](#how-it-works) for the
full idempotency guarantee.

**How do I apply database migrations in production?**

Run `npx prisma migrate deploy` before the application process starts. This
command is non-interactive and safe to run on every deploy; it applies only
pending migrations. Never use `prisma migrate dev` in production — it is
interactive and intended for local development only. The
[Deployment — Migrations](#migrations) section shows the recommended patterns
for init-containers and pre-deploy hooks.

## Troubleshooting

### Database not running

**Error text:**

```
Database connectivity check failed: connection refused
```

or

```
PrismaClientKnownRequestError: Error in PostgreSQL connection pool: server closed the connection unexpectedly
```

**Cause:** The PostgreSQL database is not running or is not reachable at the address specified in `DATABASE_URL`.

**Fix:**

1. If using Docker Compose, start the database:
   ```bash
   docker compose up -d postgres
   ```

2. Verify the database is running:
   ```bash
   docker compose ps postgres
   ```

3. Check that `DATABASE_URL` in your `.env` file matches the Docker Compose configuration:
   ```
   DATABASE_URL=postgresql://tricklepay:tricklepay@localhost:5432/tricklepay
   ```

4. If the database is running but still unreachable, check that the port is not blocked and the container is healthy.

---

### Missing contract id

**Error text:**

```
Missing required environment variable: STREAM_CONTRACT_ID
```

or

```
Configuration error: STREAM_CONTRACT_ID is required
```

**Cause:** The `STREAM_CONTRACT_ID` environment variable is not set. This is the only required variable besides `DATABASE_URL`.

**Fix:**

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set `STREAM_CONTRACT_ID` to the deployed contract address:
   ```
   STREAM_CONTRACT_ID=C... (your deployed contract id)
   ```

3. The contract id starts with `C` and is obtained after deploying the Soroban streaming contract. See the [contracts](https://github.com/TricklePay/tricklepay-contracts) repository for deployment instructions.

---

### Prisma client not generated

**Error text:**

```
TypeError: Cannot find module '@prisma/client'
```

or

```
Error: @prisma/client did not initialize yet. Please run "prisma generate"
```

**Cause:** The Prisma client has not been generated from the schema. This is required before the application can interact with the database.

**Fix:**

1. Generate the Prisma client:
   ```bash
   npx prisma generate
   ```

2. If you also need to apply database migrations (required for a fresh database):
   ```bash
   npx prisma migrate deploy
   ```

3. The `scripts/dev.sh` script runs both steps automatically, so if you use that script you should not encounter this issue.

---

### TypeScript compilation errors

**Error text:**

```
error TSxxxx: Cannot find name '...'
```

or

```
error TSxxxx: Type '...' is not assignable to type '...'
```

**Cause:** The codebase has TypeScript errors that prevent compilation.

**Fix:**

1. Run the type checker to see all errors:
   ```bash
   npm run typecheck
   ```

2. Ensure you have the correct Node.js version:
   ```bash
   nvm use
   ```

3. Reinstall dependencies if needed:
   ```bash
   rm -rf node_modules
   npm install
   ```

---

### Port already in use

**Error text:**

```
Error: listen EADDRINUSE: address already in use :::3000
```

**Cause:** Another process is already using port 3000 (the default API port).

**Fix:**

1. Find the process using the port:
   ```bash
   lsof -i :3000
   ```

2. Either stop the other process or configure a different port in your `.env`:
   ```
   PORT=3001
   ```

---

### Tests failing

**Error text:**

```
FAIL tests/...
AssertionError: expected ... to equal ...
```

**Cause:** Tests are failing, possibly due to environment issues or code changes.

**Fix:**

1. Run the full test suite:
   ```bash
   npm test
   ```

2. Run the type checker first to ensure no type errors:
   ```bash
   npm run typecheck
   ```

3. Check that your environment is set up correctly (database running, migrations applied).

4. If a specific test is failing, run only that test file:
   ```bash
   npx vitest run --project unit tests/path/to/test.test.ts
   ```

## Documentation & Guides

Comprehensive technical documentation is maintained under the [`docs/`](docs/) directory:

- **[Running Against a Local Network](docs/local-network.md)** — Step-by-step setup and configuration for developing against local Soroban RPC nodes.
- **[Derived Figures & Dynamic Vesting](docs/derived-figures.md)** — Rationale for computing vesting figures per request and on-chain consistency guarantees.
- **[API Versioning Policy](docs/api-versioning.md)** — Stability guarantees, breaking change definitions, and deprecation timelines.
- **[Shutdown Ordering and Rationale](docs/shutdown-ordering.md)** — Graceful termination order protecting transactions and in-flight HTTP requests.
- **[Structured Logging and Log Fields](docs/logging.md)** — Guide to log severity levels, common metadata, and request-tracing fields.
- **[Endpoint Failure Modes and Error Handling](docs/endpoint-failure-modes.md)** — Detailed failure matrix, status codes, and `ApiErrorCode` definitions.
- **[End-to-End Request Lifecycle](docs/request-lifecycle.md)** — Architecture flowchart and step-by-step layer responsibilities.
- **[Failed Events Retention Guide](docs/failed-events-retention.md)** — Cleanup policies and maintenance queries for the `FailedEvent` table.
- **[Contributing Guide](CONTRIBUTING.md)** — Coding standards, repository layer conventions, and testing workflows.

## Related repositories

- **tricklepay-contracts** — the Soroban streaming contract this service indexes.
- **tricklepay-frontend** — web client built on this API.
- **tricklepay-docs** — architecture, security model, and contributor guides.

## License

MIT. See [LICENSE](LICENSE).

