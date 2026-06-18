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

The contract emits `Created`, `Withdrawn`, and `Cancelled` events. The indexer
reads each event to learn which stream changed, then reads that stream's full
authoritative state with a `get_stream` simulation and upserts it into Postgres.
Reading full state rather than trusting event payloads keeps the mirror correct
regardless of which event fired, and makes re-processing an event harmless — so
the indexer can crash and resume without corrupting data.

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
    contract.ts       read full stream state via get_stream
  indexer/
    apply.ts          apply a decoded event to the database
    poller.ts         poll loop with cursor persistence
  repositories/
    streams.ts        stream upserts and queries
    indexer-state.ts  cursor bookkeeping
  lib/
    vesting.ts        linear vesting math, mirroring the contract
  routes/
    streams.ts        GET /streams and GET /streams/:id
prisma/
  schema.prisma       Stream and IndexerState models
```

## Related repositories

- **tricklepay-contracts** — the Soroban streaming contract this service indexes.
- **tricklepay-frontend** — web client built on this API.
- **tricklepay-docs** — architecture, security model, and contributor guides.

## License

MIT. See [LICENSE](LICENSE).
