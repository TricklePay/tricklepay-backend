# TricklePay Backend

Indexer and read API for TricklePay token streams on Stellar.

This service has two halves that run in one process:

- An **indexer** that polls the stream contract's events over Soroban RPC and
  keeps a Postgres mirror of every stream's state.
- A **read API** that serves that data over HTTP, computing live vested and
  withdrawable amounts on each request so clients never have to query the chain
  directly.

It backs the TricklePay web client and pairs with the
[contracts](#related-repositories) repository, which holds the on-chain logic.
For a record of API and indexer behavior changes, see the [Changelog](CHANGELOG.md).

## Table of Contents

- [How it works](#how-it-works)
- [API](#api)
- [Error Responses](#error-responses)
- [Health Endpoint Semantics](#health-endpoint-semantics)
- [Metrics](#metrics)
- [Running locally](#running-locally)
- [Testing](#testing)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Frequently asked questions](#frequently-asked-questions)
- [Related repositories](#related-repositories)
- [License](#license)

## How it works

The contract emits `Created`, `Withdrawn`, and `Cancelled` events, and between
them they carry everything the mirror needs. `Created` holds a whole stream —
sender, recipient, token, total, and the `startTime`/`endTime`/`cliffTime`
schedule, with `withdrawn` at zero and `cancelled` false by definition — while
`Withdrawn` and `Cancelled` carry the deltas that move one. So the indexer
writes each event straight to Postgres: one query per event and no chain
round-trip. That is what makes a backfill cheap, since an historical event costs
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
chain round-trip.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Service index: name, version, and a list of endpoints. |
| `GET` | `/health` | Liveness check. Returns 200 with the service version; performs no database read. |
| `GET` | `/ready` | Readiness check. Verifies database connectivity and reports indexer lag; returns 503 when the database is unavailable. |
| `GET` | `/status` | Indexer progress against the chain. |
| `GET` | `/streams` | List streams. Query params: `sender`, `recipient`, `token`, `limit`, `offset`, `includeTotal`, `cancelled`, `cursor`. Address filters accept lowercase and padded spellings and are normalized before matching. `total` is only included when `includeTotal=true`; `cancelled` filters by cancellation status when given, and is omitted to return both. |

### Pagination Parameters

The `GET /streams` endpoint supports pagination through the following query parameters:

| Parameter | Type | Default | Maximum | Description |
|-----------|------|---------|---------|-------------|
| `limit` | integer | 50 | 100 | Maximum number of streams to return per page |
| `offset` | integer | 0 | 10,000 | Zero-based index of the first stream to return |
| `cursor` | string | - | - | Opaque cursor from a previous response for stable pagination |
| `includeTotal` | boolean | false | - | When `true`, includes the total count of matching streams |

**Note:** When `cursor` is provided, `offset` is ignored and offset ceiling checks are skipped. Use cursor-based pagination for stable results under concurrent inserts.
| `GET` | `/streams/summary` | Counts and exact amount totals per status (`pending`, `streaming`, `completed`, `cancelled`). |
| `GET` | `/streams/:id` | A single stream by id. |
| `GET` | `/metrics` | Prometheus metrics. |
| `GET` | `/docs` | Interactive Swagger UI; the raw OpenAPI spec is served at `/docs/json` and `/docs/yaml`. |

Each stream is returned with its stored fields plus derived `vested`,
`withdrawable`, `locked`, `progress`, and `status` (`pending`, `streaming`,
`completed`, or `cancelled`). `progress` is vesting progress in basis points
(0–10000).

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
    "lastLedger": 56290013,
    "cursor": "0241763764928512000-0000000001",
    "updatedAt": "2025-11-14T03:00:00.000Z"
  },
  "chain": { "latestLedger": 56999999 },
  "lagLedgers": 709986
}
```

`indexer.lastLedger` is the highest ledger whose events have been applied, so a
backfill reads as behind for as long as it is behind. Both figures are as of the
last completed poll — the API never queries the chain — and `updatedAt` says
when that was, which is how a stalled indexer, whose lag stops growing, is told
apart from one that is genuinely level. `lagLedgers` is null until the first
poll has recorded something to measure.

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
  "version": "1.0.0"
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

Requires **Node.js 20.12 or later**, Docker, and the deployed contract id. The minimum is Node 20.12 because the service uses the built-in `node:` protocol imports and native fetch, which are only fully stable from that release onward — older versions will fail at install or startup. The `engines.node` field in [package.json](package.json) encodes this requirement (`>=20.12`), and the repository also includes a `.nvmrc` pinned to `20.12.0` so `nvm use` drops you onto the right version automatically.

```bash
nvm use
cp .env.example .env        # then set STREAM_CONTRACT_ID
npm install
./scripts/dev.sh            # starts Postgres, syncs schema, runs with reload
```

Or run everything in containers:

```bash
STREAM_CONTRACT_ID=C... docker compose up
```

The API listens on `http://localhost:3000`.

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
current template — copy it and fill in the required values. The only required
variables are `DATABASE_URL` and `STREAM_CONTRACT_ID`.

Everything else is optional, and the template lists each with its default:
the network defaults to testnet, the RPC URL to the public endpoint for the
selected network (`SOROBAN_RPC_URL` to override), the server listens on
`PORT`/`HOST`, and `CORS_ORIGIN` pins which browser origin may call the API.
`LOG_LEVEL` sets log verbosity, `BODY_LIMIT` and `QUERY_STRING_LIMIT` bound
request sizes. The indexer polls every `INDEXER_POLL_INTERVAL_MS` (minimum
1000) starting from `INDEXER_START_LEDGER` — zero means start at the chain's
latest ledger rather than replaying history. On repeated RPC failures the retry delay doubles each time up to `INDEXER_BACKOFF_MAX_MS` (default 60000), then resets to the normal interval after a successful poll, so a struggling endpoint is not hammered on a fixed schedule. `INDEXER_MAX_PAGES_PER_TICK` (default 1000) caps how many event pages one poll fetches, so a deep backlog is spread across ticks; the cursor is saved after each page so progress is kept.

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
`error`, and `fatal`. The default is `info`, which logs normal operational
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
  A readiness probe should take the instance out of load-balancer rotation on a
  503 without restarting it — the process is fine, a dependency isn't.

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
does not force-exit early on its own.

## Project structure

The `src/` directory is split across several modules:

- **`chain/`**: Soroban RPC integration, decoding contract events, and querying on-chain state.
- **`indexer/`**: Polling the blockchain and applying streamed events to the database.
- **`lib/`**: Shared utilities and domain logic like vesting math.
- **`repositories/`**: Database access layer for reading and writing models.
- **`routes/`**: HTTP API endpoints served by Fastify.

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

## Related repositories

- **tricklepay-contracts** — the Soroban streaming contract this service indexes.
- **tricklepay-frontend** — web client built on this API.
- **tricklepay-docs** — architecture, security model, and contributor guides.

## License

MIT. See [LICENSE](LICENSE).
