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

## Refreshing the fixture

When the contract emits new event shapes or the RPC envelope changes, replace
the fixture with a fresh capture. The assertions in `events.test.ts` index into
the page by position, so a replacement needs those indices and expected values
updated alongside the fixture.

### Capture command

Point `curl` at an RPC node running against a network where the stream contract
is deployed. Replace `<ledger>` with a ledger known to contain stream events and
`<STREAM_CONTRACT_ID>` with the contract's strkey address:

```bash
curl -s https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getEvents","params":{
        "startLedger":<ledger>,
        "filters":[{"type":"contract","contractIds":["<STREAM_CONTRACT_ID>"]}],
        "pagination":{"limit":100}}}' \
  | jq . > tests/fixtures/get-events.json
```

Keep the response whole — do not strip or reorder fields — so the fixture
matches what `rpc.Server.getEvents` actually returns.

### Redaction expectations

The fixture must not contain:

- **Private keys or signing seeds.** Addresses are fine; seeds are not.
- **Real RPC credentials or API keys.** The curl command hits a public node.
- **Timestamps that pin to a specific wall clock.** Ledger close times are
  acceptable because they are chain-anchored and immutable; avoid injecting
  `Date.now()` or similar into expected values.

If the capture includes events unrelated to the stream contract (e.g. from
other contracts sharing the same network), trim the `result.events` array to
only stream-contract events before committing.

### Compatibility notes

- The fixture is versioned alongside `@stellar/stellar-sdk` in `package.json`.
  After a major SDK bump, re-run the capture to pick up any encoding changes.
- The decoder tests assert exact field sets per event kind. If the contract adds
  a field, the fixture and its assertions must be updated in lockstep.
- The two unknown-event entries (`paused`, `schedule_extended`) are synthetic
  stand-ins for future contract versions. They must remain in the fixture even
  if the contract later defines real events with those names — replace them
  with different unknown names to keep the "unknown = skip" test coverage.

### Validation

After replacing the fixture, run the decoder tests to confirm the page still
decodes:

```bash
npx vitest run tests/chain/events.test.ts
```
