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
| `GET` | `/streams` | List streams. Query params: `sender`, `recipient`, `token`, `limit` (max 100), `offset` (max 10000), `includeTotal`, `cancelled`. Address filters accept lowercase and padded spellings and are normalized before matching. `total` is only included when `includeTotal=true`; `cancelled` filters by cancellation status when given, and is omitted to return both. |
| `GET` | `/streams/summary` | Counts and exact amount totals per status (`pending`, `streaming`, `completed`, `cancelled`). |
| `GET` | `/streams/:id` | A single stream by id. |
| `GET` | `/metrics` | Prometheus metrics. |
| `GET` | `/docs` | Interactive Swagger UI; the raw OpenAPI spec is served at `/docs/json` and `/docs/yaml`. |

Each stream is returned with its stored fields plus derived `vested`,
`withdrawable`, `locked`, `progress`, and `status` (`pending`, `streaming`,
`completed`, or `cancelled`). `progress` is vesting progress in basis points
(0–10000). All amounts are strings to preserve 128-bit precision.

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

## Running locally

Requires Node 20.12+, Docker, and the deployed contract id.

```bash
cp .env.example .env        # then set STREAM_CONTRACT_ID
npm install
./scripts/dev.sh            # starts Postgres, syncs schema, runs with reload
```

Or run everything in containers:

```bash
STREAM_CONTRACT_ID=C... docker compose up
```

The API listens on `http://localhost:3000`.

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
latest ledger rather than replaying history. `INDEXER_MAX_PAGES_PER_TICK`
(default 1000) caps how many event pages one poll fetches, so a deep backlog is
spread across ticks; the cursor is saved after each page so progress is kept.

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

### Graceful termination

On `SIGTERM` or `SIGINT` the process shuts down in a fixed order
([index.ts](src/index.ts)): it stops the indexer poller first (no new poll
ticks start), then closes the HTTP server (Fastify stops accepting new
connections and waits for in-flight requests to finish), then drains the
Postgres connection pool, then exits `0`. Give the platform's termination
grace period enough headroom for in-flight requests to finish — the process
does not force-exit early on its own.

## Project structure

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

## Related repositories

- **tricklepay-contracts** — the Soroban streaming contract this service indexes.
- **tricklepay-frontend** — web client built on this API.
- **tricklepay-docs** — architecture, security model, and contributor guides.

## License

MIT. See [LICENSE](LICENSE).
