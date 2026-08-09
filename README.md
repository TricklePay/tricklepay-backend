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

The API reads only from Postgres. On every request it recomputes vested and
withdrawable amounts with the same linear formula the contract uses, against the
current clock, so the numbers are always current without a chain round-trip.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness check. |
| `GET` | `/streams` | List streams. Query params: `sender`, `recipient`, `limit` (max 100), `offset`. |
| `GET` | `/streams/:id` | A single stream by id. |

Each stream is returned with its stored fields plus derived `vested`,
`withdrawable`, and `status` (`pending`, `streaming`, `completed`, or
`cancelled`). All amounts are strings to preserve 128-bit precision.

## Running locally

Requires Node 20+, Docker, and the deployed contract id.

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
`chain/events.ts`, which is decoded from a stored Soroban RPC `getEvents`
response, and `indexer/apply.ts`, which turns those decoded events into writes
with the database and the chain stubbed — including the assertion that indexing
a page of events makes no chain calls. See
[tests/fixtures/](tests/fixtures/README.md) for the captured response's
provenance and how to refresh it. `npm run typecheck` covers the tests as well
as `src`.

## Configuration

All configuration is read from the environment; see `.env.example` for the full
list. The required variables are `DATABASE_URL` and `STREAM_CONTRACT_ID`. The
network defaults to testnet, and the RPC URL defaults to the public endpoint for
the selected network.

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
    streams.ts        stream writes, event driven and reconciling, and queries
    indexer-state.ts  cursor bookkeeping
  lib/
    vesting.ts        linear vesting math, mirroring the contract
  routes/
    streams.ts        GET /streams and GET /streams/:id
tests/
  lib/
    vesting.test.ts   vesting math, mirroring the contract's Rust tests
  chain/
    events.test.ts    event decoding against captured RPC payloads
  indexer/
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
