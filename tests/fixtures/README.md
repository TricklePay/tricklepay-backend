# Test fixtures

## `get-events.json`

A Soroban RPC `getEvents` response in the exact envelope the endpoint returns,
with `topic` and `value` as base64 XDR. `tests/chain/events.test.ts` feeds
`result` straight to the SDK's `rpc.parseRawEvents` — the same call
`rpc.Server.getEvents` makes — so the decoder is exercised against real XDR
bytes rather than hand-built `ScVal` objects.

The XDR was produced with `@stellar/stellar-sdk` to match the encoding
`soroban_sdk`'s `#[contractevent]` emits: the first topic is the event name as a
symbol, the remaining topics are the indexed fields, and the value is an `ScMap`
of the rest keyed by symbol in sorted order. Addresses, transaction hashes,
ledger sequences and event ids (`TOID-index`) are well-formed but do not
reference a real network.

The page holds six events, in this order:

| # | Event | Covers |
| --- | --- | --- |
| 0 | `created` | the full mapping, account addresses on both sides, a cliff between start and end |
| 1 | `withdrawn` | delta-only payload |
| 2 | `cancelled` | both sides of the split |
| 3 | `created` | max `u64` id, max `i128` total, a contract address as sender, and a schedule with no cliff |
| 4 | `paused` | an unknown event whose value is a bare scalar, not a map |
| 5 | `schedule_extended` | an unknown event whose value is a map |

The last two stand in for events a future contract version might add: the
decoder has to skip them rather than fail, so the indexer keeps working against
a newer contract.

To replace this with a genuine capture, point `curl` at an RPC node running
against a network where the stream contract is deployed and keep the response
whole:

```bash
curl -s https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getEvents","params":{
        "startLedger":<ledger>,
        "filters":[{"type":"contract","contractIds":["<STREAM_CONTRACT_ID>"]}],
        "pagination":{"limit":100}}}' \
  | jq . > tests/fixtures/get-events.json
```

The assertions in `events.test.ts` index into the page by position, so a
replacement fixture needs those indices and the expected values updated with it.
