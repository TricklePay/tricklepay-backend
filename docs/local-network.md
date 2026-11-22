# Running Against a Local Network

This guide explains how to configure and run the TricklePay backend service against a local Stellar / Soroban development network (such as a local `stellar-quickstart` container or a standalone Soroban RPC instance).

## Why Develop Against a Local Network?

Developing against a local network avoids dependency on public testnet or mainnet infrastructure, removes rate limits, enables offline development, and provides deterministic testing where contracts can be deployed and reset at will.

## Configuration Changes

To point the indexer and API at a local network, configure the following environment variables in your `.env` file:

```env
# 1. Network identification
NETWORK=local

# 2. Soroban RPC endpoint (points to your local RPC server)
SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc

# 3. Stream Contract ID (the address of the deployed contract on your local network)
STREAM_CONTRACT_ID=CBZ7...YOUR_LOCAL_CONTRACT_ID

# 4. Starting Ledger for Indexing
INDEXER_START_LEDGER=1

# 5. Database URL (Postgres container or local instance)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tricklepay
```

### Key Configuration Differences

| Variable | Local Network Value | Testnet / Mainnet Default | Rationale |
| --- | --- | --- | --- |
| `NETWORK` | `local` | `testnet` | Identifies the active network in the service index (`GET /`) and metrics. |
| `SOROBAN_RPC_URL` | `http://localhost:8000/soroban/rpc` | Public network RPC URL | Directs RPC event queries and simulations to the local node. |
| `STREAM_CONTRACT_ID` | `<local-contract-id>` | `<deployed-contract-id>` | Must match the contract instance deployed to the local ledger. |
| `INDEXER_START_LEDGER` | `1` | `0` (chain head) | Fresh local networks start from ledger 1. Setting this to `1` ensures the indexer captures contract initialization and streams created during initial setup. |
| `INDEXER_POLL_INTERVAL_MS` | `1000` | `2000` | Local networks can be polled faster (minimum 1000ms) for snappy local feedback. |

## Plain HTTP is only allowed for local RPC hosts

`SOROBAN_RPC_URL` is checked at startup, before anything else runs. A
`http://` URL is accepted only when it points at one of these hosts:

- `localhost`
- Any IPv4 address in the `127.0.0.0/8` loopback range (`127.0.0.1`,
  `127.0.0.2`, `127.255.255.255`, …) — not just `127.0.0.1`
- The IPv6 loopback address, written as `::1` or `[::1]` (with a port:
  `[::1]:8000`)

Any other host — `http://my-rpc-node.internal:8000`, an RPC reachable over a
VPN or a private subnet, a `127.`-prefixed hostname that isn't actually the
loopback address itself (`http://127.evil.com`), anything — must use
`https://`. The check only looks at the hostname the URL resolves to, so a
hostname merely starting with "127." does not qualify.

**Why remote hosts must use HTTPS:** every stream balance this service
reports is derived from events this RPC call returns, so a connection to it
that can be read or tampered with in transit (a plain HTTP request to
anything off the local machine) can feed the indexer forged events or
tampered chain state. Loopback traffic never leaves the machine, so there is
no network path to intercept; anything else does, so it has to be encrypted.
Rejecting this at config load — rather than warning, or silently working over
plain HTTP — means a `.env` typo (a dropped `s`, a URL copied from a local
setup into a staging deploy) fails the service on startup instead of quietly
indexing over an unencrypted connection.

If `SOROBAN_RPC_URL` fails this check, the service refuses to start with:

```
Error: SOROBAN_RPC_URL "http://my-rpc-node.internal:8000" uses plain HTTP on a non-local host. Remote endpoints must use HTTPS. Use http:// only for localhost, 127.x.x.x or [::1].
```

The fix is almost always one of: switch the URL to `https://`, or, if the RPC
genuinely only runs on this machine, point at `localhost`/`127.0.0.1` instead
of a hostname or LAN IP that merely happens to resolve there — the check
only reads the literal host in the URL, not where it resolves to.

## Start Ledger Choice for Fresh Networks

On public networks (`testnet` or `mainnet`), `INDEXER_START_LEDGER=0` is often used to start indexing from the chain's latest ledger when history replay is not needed.

However, on a **fresh local network**, the ledger sequence starts at `1` (or a very low number after genesis). **You must set `INDEXER_START_LEDGER=1`** so that:
- The indexer does not skip contract deployment and initialization events that occurred right after network startup.
- All streams created during local testing are captured from the very beginning.

## Step-by-Step Local Setup

1. **Start your local Stellar / Soroban node**:
   ```bash
   docker run --rm -it \
     -p 8000:8000 \
     --name stellar \
     stellar/quickstart:latest \
     --local \
     --enable-soroban-rpc
   ```

2. **Deploy the TricklePay contract** to the local network using the Stellar CLI and record the resulting contract ID.

3. **Configure `.env`**:
   ```bash
   cp .env.example .env
   # Edit .env and set NETWORK=local, SOROBAN_RPC_URL, and STREAM_CONTRACT_ID
   ```

4. **Start PostgreSQL and run migrations**:
   ```bash
   docker compose up -d postgres
   npx prisma migrate deploy
   ```

5. **Start the backend in development mode**:
   ```bash
   npm run dev
   ```

6. **Verify indexer status**:
   ```bash
   curl http://localhost:3000/status
   ```
