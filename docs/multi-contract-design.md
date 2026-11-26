# Multi-Contract Indexing Design

## Overview

Currently, the backend indexes exactly one stream contract specified by `STREAM_CONTRACT_ID`. This design extends the service to index multiple contracts simultaneously, allowing a single deployment to serve testnet and mainnet contracts, or to migrate between contract versions without downtime.

## Goals

1. Allow one backend instance to index multiple stream contracts concurrently
2. Maintain backward compatibility with existing single-contract deployments
3. Ensure stream IDs remain unique per contract in all queries
4. Support incremental contract addition without re-indexing existing data

## Schema Changes

### Stream Table

Add a `contractId` column to identify which contract each stream belongs to:

```sql
ALTER TABLE "Stream" ADD COLUMN "contractId" VARCHAR(56) NOT NULL;
ALTER TABLE "Stream" DROP CONSTRAINT "Stream_pkey";
ALTER TABLE "Stream" ADD PRIMARY KEY ("contractId", "streamId");
```

**Indexes to update:**
```sql
-- Replace existing indexes with composite versions
DROP INDEX "Stream_sender_streamId_idx";
DROP INDEX "Stream_recipient_streamId_idx";
DROP INDEX "Stream_token_streamId_idx";

CREATE INDEX "Stream_sender_contractId_streamId_idx" ON "Stream"("sender", "contractId", "streamId" DESC);
CREATE INDEX "Stream_recipient_contractId_streamId_idx" ON "Stream"("recipient", "contractId", "streamId" DESC);
CREATE INDEX "Stream_token_contractId_streamId_idx" ON "Stream"("token", "contractId", "streamId" DESC);
CREATE INDEX "Stream_contractId_streamId_idx" ON "Stream"("contractId", "streamId" DESC);
```

### IndexedEvent Table

Add `contractId` to track which contract emitted each event:

```sql
ALTER TABLE "IndexedEvent" ADD COLUMN "contractId" VARCHAR(56) NOT NULL;
CREATE INDEX "IndexedEvent_contractId_ledger_idx" ON "IndexedEvent"("contractId", "ledger");
```

The existing `eventId` remains the primary key since TOID-index values are globally unique across all contracts on a network.

### FailedEvent Table

Add `contractId` to identify the source contract for failed events:

```sql
ALTER TABLE "FailedEvent" ADD COLUMN "contractId" VARCHAR(56) NOT NULL;
CREATE INDEX "FailedEvent_contractId_ledger_idx" ON "FailedEvent"("contractId", "ledger");
```

### IndexerState Table

Replace the singleton row model with per-contract cursor tracking:

```sql
-- Current: id = "stream" (singleton)
-- New: id = contractId (one row per contract)

-- Migration: rename existing singleton row to the current contract ID
UPDATE "IndexerState" SET "id" = '<CURRENT_CONTRACT_ID>' WHERE "id" = 'stream';
```

Each contract maintains independent indexing state:
- `id`: The contract ID (primary key)
- `lastLedger`: Highest ledger applied for this contract
- `chainLedger`: Chain head as of last poll for this contract
- `cursor`: RPC paging cursor for this contract's events

## Configuration Changes

### Environment Variables

Replace single contract ID with a comma-separated list:

```bash
# Old (still supported for backward compatibility)
STREAM_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC

# New (multiple contracts)
STREAM_CONTRACT_IDS=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC,CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
```

**Backward compatibility:** If `STREAM_CONTRACT_IDS` is not set, fall back to `STREAM_CONTRACT_ID` and treat it as a single-element list.

**Validation:**
- Each contract ID must be a valid 56-character Soroban contract address starting with "C"
- Duplicate contract IDs in the list are rejected at startup
- Empty list is rejected (at least one contract required)

## Indexer Changes

### Polling Strategy

Each contract is polled independently with its own cursor and state:

```typescript
class MultiContractPoller {
  private pollers: Map<string, ContractPoller>;
  
  async start() {
    for (const contractId of config.contractIds) {
      const poller = new ContractPoller(contractId, server, config, logger);
      this.pollers.set(contractId, poller);
      void poller.start(); // Run all pollers concurrently
    }
  }
}
```

**Key behaviors:**
- Each contract has its own `ContractPoller` instance
- Pollers run concurrently (not sequentially) to maximize throughput
- Each poller maintains independent cursor, lastLedger, and chainLedger
- Poll intervals apply per contract (each polls every `INDEXER_POLL_INTERVAL_MS`)
- Failure in one contract's poller does not stop others

### Event Application

Event application logic remains unchanged except:
1. Pass `contractId` to all repository functions
2. Store `contractId` with each Stream, IndexedEvent, and FailedEvent row
3. Query functions filter by `contractId` in WHERE clauses

### Reconciliation

When applying a delta event (Withdrawn, Cancelled) to a missing stream:
- Fetch full state from the **same contract** that emitted the event
- Use the event's `contractId` to determine which contract to query
- Upsert the stream with matching `contractId`

## API Changes

### Stream Queries

Add optional `contract` query parameter to all stream endpoints:

**GET /streams**
```
?contract=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
```

- When `contract` is provided: filter results to that contract only
- When `contract` is omitted: return streams from all indexed contracts
- Invalid contract IDs return 400 with `VALIDATION_ERROR`
- Contract IDs not in the indexed set return empty results (not an error)

**GET /streams/:id**
```
?contract=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
```

- Requires `contract` parameter (stream IDs are only unique per contract)
- Without `contract`, return 400: "contract parameter required when multiple contracts are indexed"
- For backward compatibility: if only one contract is indexed, `contract` is optional and defaults to that contract

**GET /streams/summary**

Returns per-contract summaries when multiple contracts are indexed:

```json
{
  "contracts": [
    {
      "contractId": "CCCCC...",
      "pending": 10,
      "streaming": 25,
      "completed": 100,
      "cancelled": 5,
      "totalAmountByStatus": { ... }
    },
    {
      "contractId": "CDDDD...",
      "pending": 5,
      "streaming": 15,
      "completed": 50,
      "cancelled": 2,
      "totalAmountByStatus": { ... }
    }
  ],
  "total": {
    "pending": 15,
    "streaming": 40,
    "completed": 150,
    "cancelled": 7
  }
}
```

For single-contract deployments, maintain current flat response for backward compatibility.

### Status Endpoint

**GET /status**

Return per-contract indexer state:

```json
{
  "contracts": [
    {
      "contractId": "CCCCC...",
      "indexer": {
        "initialized": true,
        "lastLedger": 56290013,
        "cursor": "0241763764928512000-0000000001",
        "updatedAt": "2025-11-14T03:00:00.000Z"
      },
      "lagLedgers": 1234
    },
    {
      "contractId": "CDDDD...",
      "indexer": {
        "initialized": true,
        "lastLedger": 56289500,
        "cursor": "0241763764928512000-0000000005",
        "updatedAt": "2025-11-14T03:00:00.000Z"
      },
      "lagLedgers": 1747
    }
  ],
  "chain": {
    "latestLedger": 56291247
  },
  "maxLagLedgers": 1747,
  "failedEventCount": 3
}
```

**Single-contract backward compatibility:** When only one contract is indexed, return the current flat structure (no `contracts` array).

## Migration Path

### For Existing Single-Contract Deployments

1. **Schema migration** (run before deploying new code):
   ```bash
   npx prisma migrate deploy
   ```
   
   The migration adds `contractId` columns with the value from the existing `STREAM_CONTRACT_ID` environment variable.

2. **Environment update** (optional):
   - Keep using `STREAM_CONTRACT_ID` (works as before)
   - Or migrate to `STREAM_CONTRACT_IDS` with the same single value

3. **Deploy new code**:
   - Existing API clients continue to work
   - Single-contract responses maintain current JSON shape

### Adding a Second Contract

1. Update environment:
   ```bash
   STREAM_CONTRACT_IDS=CEXISTING...,CNEW...
   ```

2. Restart the service:
   - New contract starts indexing from `INDEXER_START_LEDGER` (or chain head if 0)
   - Existing contract continues from its saved cursor
   - Both contracts index independently

3. Update API clients:
   - Start passing `?contract=...` parameter to disambiguate streams
   - Handle new multi-contract response formats

## Error Handling

### Contract-Specific Failures

Failed events are recorded with their source `contractId`:
- Each contract's failures are isolated
- Replay command filters by contract: `npm run replay-failed-events -- --contract CCCCC...`
- Status endpoint shows per-contract failed event counts

### RPC Failures

RPC errors for one contract do not stop polling of others:
- Each poller has independent retry backoff
- Metrics track errors per contract: `tricklepay_rpc_errors{contract="CCCCC...",operation="getContractEvents"}`

## Open Questions

1. **Cursor collision:** Can two contracts have overlapping TOID-index ranges on the same network?
   - **Answer:** Yes, TOID-index is globally unique per network, not per contract. No collision risk.

2. **Should `/streams` without `?contract=` return ALL contracts or require explicit filtering?**
   - **Proposal:** Return all contracts by default for discoverability. Clients filter explicitly when needed.

3. **Contract discovery:** Should the API expose a list of indexed contracts?
   - **Proposal:** Add `GET /contracts` returning `[{ contractId, network, startLedger, lastLedger }]`

## Testing Strategy

1. **Unit tests:** Verify contract filtering in repository queries
2. **Integration tests:** 
   - Start indexer with two mock contracts
   - Verify events from each are stored with correct `contractId`
   - Verify API filtering works correctly
3. **Migration tests:**
   - Apply schema migration to test database with existing data
   - Verify data integrity after migration
4. **Backward compatibility tests:**
   - Single-contract deployment continues to work
   - Response shapes match existing behavior

## Metrics Changes

Add `contract` label to indexer metrics:

```
tricklepay_indexer_events_applied{kind="created",outcome="applied",contract="CCCCC..."}
tricklepay_indexer_lag_ledgers{contract="CCCCC..."}
tricklepay_indexer_poll_success_total{contract="CCCCC..."}
```

## Documentation Updates

- Update README Configuration section with `STREAM_CONTRACT_IDS`
- Document `?contract=` query parameter in API section
- Update glossary with "multi-contract indexing"
- Add migration guide for existing deployments
- Update OpenAPI spec with new query parameters and response shapes

## Future Enhancements

- **Dynamic contract addition:** Add/remove contracts without restart via admin API
- **Per-contract poll intervals:** Different polling frequencies for testnet vs. mainnet
- **Contract-specific RPC URLs:** Use different Soroban RPC endpoints per contract
- **Contract versioning:** Track contract version/deployment for upgrade detection
