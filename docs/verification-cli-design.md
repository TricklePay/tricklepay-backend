# Stream Verification CLI Design

## Overview

This document describes the design for `npm run verify-streams`, a CLI tool that automates the verification procedure currently documented in [INDEXER_VERIFICATION.md](INDEXER_VERIFICATION.md). The tool compares indexed database state against authoritative on-chain state to detect drift caused by missed events, bugs, or chain reorgs.

## Goals

1. Automate manual verification steps currently performed with SQL queries and CLI tools
2. Provide machine-readable JSON output for integration with monitoring systems
3. Support sampling strategies to verify large datasets efficiently
4. Operate in read-only mode with no side effects on database or chain
5. Report all field-level differences with actionable details

## Command Interface

### Basic Usage

```bash
# Verify all streams (read-only)
npm run verify-streams

# Verify specific streams
npm run verify-streams -- --stream-ids 12345,67890,111213

# Sample random streams
npm run verify-streams -- --sample 100

# JSON output for monitoring
npm run verify-streams -- --json

# Dry run (explain what would be checked)
npm run verify-streams -- --dry-run

# Filter by contract (for multi-contract deployments)
npm run verify-streams -- --contract CCCCCC...
```

### Command Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--stream-ids` | string | - | Comma-separated list of specific stream IDs to verify |
| `--sample` | number | - | Randomly sample N streams instead of verifying all |
| `--sample-strategy` | string | `random` | Sampling strategy: `random`, `recent`, `oldest`, `high-value` |
| `--contract` | string | - | Filter to streams from specific contract ID (required for multi-contract) |
| `--json` | boolean | `false` | Output results as JSON instead of human-readable text |
| `--dry-run` | boolean | `false` | Show what would be verified without making RPC calls |
| `--concurrency` | number | `5` | Number of concurrent RPC requests |
| `--timeout` | number | `30000` | RPC timeout in milliseconds |
| `--fail-fast` | boolean | `false` | Exit on first mismatch instead of continuing |
| `--verbose` | boolean | `false` | Show detailed field-by-field comparison for each stream |

## Verification Logic

### Fields to Compare

For each stream, compare all mirrored fields between database and on-chain state:

| Field | Database Source | On-Chain Source | Comparison |
|-------|----------------|-----------------|------------|
| `streamId` | `Stream.streamId` | Contract key | Exact match |
| `sender` | `Stream.sender` | `get_stream().sender` | Address equality (normalized) |
| `recipient` | `Stream.recipient` | `get_stream().recipient` | Address equality (normalized) |
| `token` | `Stream.token` | `get_stream().token` | Address equality (normalized) |
| `totalAmount` | `Stream.totalAmount` | `get_stream().total_amount` | Numeric equality |
| `withdrawn` | `Stream.withdrawn` | `get_stream().withdrawn` | Numeric equality |
| `startTime` | `Stream.startTime` | `get_stream().start_time` | Unix timestamp equality |
| `endTime` | `Stream.endTime` | `get_stream().end_time` | Unix timestamp equality |
| `cliffTime` | `Stream.cliffTime` | `get_stream().cliff_time` | Unix timestamp equality |
| `cancelled` | `Stream.cancelled` | `get_stream().cancelled` | Boolean equality |

### Address Normalization

Stellar addresses can be represented in different formats:
- Uppercase vs. lowercase
- Padded vs. unpadded contract addresses

**Normalization rules:**
1. Convert all addresses to canonical StrKey format using `@stellar/stellar-sdk`
2. Compare case-insensitively
3. Treat missing optional fields as equivalent to their zero/default values

### Comparison Algorithm

```typescript
interface VerificationResult {
  streamId: string;
  status: 'match' | 'mismatch' | 'missing_onchain' | 'missing_database' | 'error';
  differences?: FieldDifference[];
  error?: string;
}

interface FieldDifference {
  field: string;
  databaseValue: string | number | boolean | null;
  onchainValue: string | number | boolean | null;
  normalized?: boolean; // true if difference is only in representation
}

async function verifyStream(streamId: bigint, contractId: string): Promise<VerificationResult> {
  // 1. Fetch database state
  const dbStream = await prisma.stream.findUnique({
    where: { streamId, contractId }
  });
  
  // 2. Fetch on-chain state
  const onChainStream = await fetchStream(server, contractId, networkPassphrase, streamId);
  
  // 3. Compare existence
  if (!dbStream && !onChainStream) return { streamId, status: 'error', error: 'Stream not found in either source' };
  if (!dbStream) return { streamId, status: 'missing_database' };
  if (!onChainStream) return { streamId, status: 'missing_onchain' };
  
  // 4. Compare all fields
  const differences = compareFields(dbStream, onChainStream);
  
  return {
    streamId: streamId.toString(),
    status: differences.length > 0 ? 'mismatch' : 'match',
    differences: differences.length > 0 ? differences : undefined
  };
}
```

## Sampling Strategies

### Random Sampling (`--sample-strategy random`)
Select N streams uniformly at random from the entire dataset:
```sql
SELECT "streamId" FROM "Stream" ORDER BY RANDOM() LIMIT N;
```

### Recent Streams (`--sample-strategy recent`)
Verify the N most recently created streams:
```sql
SELECT "streamId" FROM "Stream" ORDER BY "createdLedger" DESC LIMIT N;
```

### Oldest Streams (`--sample-strategy oldest`)
Verify the N oldest streams (most likely to have experienced drift):
```sql
SELECT "streamId" FROM "Stream" ORDER BY "createdLedger" ASC LIMIT N;
```

### High-Value Streams (`--sample-strategy high-value`)
Verify streams with the highest total amounts:
```sql
SELECT "streamId" FROM "Stream" ORDER BY "totalAmount" DESC LIMIT N;
```

## Output Formats

### Human-Readable Output (Default)

```
Stream Verification Report
==========================
Contract: CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
Streams verified: 1,234
Matches: 1,230 (99.68%)
Mismatches: 3 (0.24%)
Missing on-chain: 1 (0.08%)
Missing in database: 0 (0.00%)
Errors: 0 (0.00%)

MISMATCHES:
-----------
Stream 12345:
  - withdrawn: database=1000000000, on-chain=1500000000 (database behind by 500000000)
  
Stream 67890:
  - cancelled: database=false, on-chain=true
  - endTime: database=1735689600, on-chain=1735603200 (frozen at cancellation)

Stream 111213:
  - totalAmount: database=5000000000, on-chain=5000000001 (1 stroop difference)

MISSING ON-CHAIN:
-----------------
Stream 999999: Exists in database but get_stream() returned null

Verification completed in 45.3s
3 issues require investigation
```

### JSON Output (`--json`)

```json
{
  "summary": {
    "contractId": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    "totalStreams": 1234,
    "matches": 1230,
    "mismatches": 3,
    "missingOnChain": 1,
    "missingDatabase": 0,
    "errors": 0,
    "durationMs": 45321,
    "timestamp": "2026-11-23T10:30:00.000Z"
  },
  "results": [
    {
      "streamId": "12345",
      "status": "mismatch",
      "differences": [
        {
          "field": "withdrawn",
          "databaseValue": "1000000000",
          "onchainValue": "1500000000"
        }
      ]
    },
    {
      "streamId": "67890",
      "status": "mismatch",
      "differences": [
        {
          "field": "cancelled",
          "databaseValue": false,
          "onchainValue": true
        },
        {
          "field": "endTime",
          "databaseValue": "1735689600",
          "onchainValue": "1735603200"
        }
      ]
    },
    {
      "streamId": "999999",
      "status": "missing_onchain"
    }
  ],
  "config": {
    "sample": null,
    "sampleStrategy": "random",
    "concurrency": 5,
    "contractId": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
  }
}
```

## Implementation Structure

### File Organization

```
src/
  cli/
    verify-streams.ts       # Main CLI entry point
    verify/
      compare.ts            # Field comparison logic
      fetch.ts              # Database and RPC data fetching
      output.ts             # Formatting (human-readable and JSON)
      sample.ts             # Sampling strategies
      types.ts              # Shared types
```

### package.json Script

```json
{
  "scripts": {
    "verify-streams": "tsx src/cli/verify-streams.ts"
  }
}
```

### Error Handling

| Error Type | Behavior | Exit Code |
|------------|----------|-----------|
| Configuration error (missing env vars) | Print error, exit immediately | 1 |
| Database connection failure | Print error, exit immediately | 1 |
| RPC connection failure | Print error, exit immediately | 1 |
| Individual stream fetch error | Log warning, continue with next stream | 0 (unless `--fail-fast`) |
| All streams failed | Print summary, exit with error | 1 |
| Mismatches found (non-error) | Print report, exit success | 0 |

**Rationale:** Mismatches are expected outcomes, not errors. Exit code 0 allows the tool to be used in monitoring without alerting on legitimate drift. Callers should parse the JSON output to determine if action is needed.

## Concurrency and Rate Limiting

### RPC Request Concurrency

Use a semaphore pattern to limit concurrent RPC calls:

```typescript
const concurrency = options.concurrency ?? 5;
const semaphore = new Semaphore(concurrency);

for (const streamId of streamIds) {
  await semaphore.acquire();
  void verifyStream(streamId).finally(() => semaphore.release());
}
```

**Default concurrency:** 5 parallel requests
**Rationale:** Balance verification speed against RPC rate limits and resource usage

### Timeout Handling

Each RPC call has an independent timeout:
- Default: 30 seconds
- Configurable via `--timeout`
- After timeout, mark stream as `error` and continue

## Dry Run Mode

`--dry-run` mode prints the verification plan without making RPC calls:

```
Dry Run: Stream Verification Plan
==================================
Contract: CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
Streams to verify: 1,234 (all streams)
Sampling strategy: none
Concurrency: 5
RPC endpoint: https://soroban-testnet.stellar.org

Fields to compare:
  - streamId
  - sender
  - recipient
  - token
  - totalAmount
  - withdrawn
  - startTime
  - endTime
  - cliffTime
  - cancelled

Estimated duration: ~4.1 minutes (1234 streams * 200ms avg per stream / 5 concurrent)
Estimated RPC calls: 1,234

Run without --dry-run to execute verification.
```

## Monitoring Integration

### Exit Codes for Automation

```bash
# Example monitoring script
npm run verify-streams -- --json --sample 100 > /tmp/verification.json

if [ $? -ne 0 ]; then
  echo "Verification command failed"
  exit 1
fi

# Parse JSON and alert if mismatches exceed threshold
MISMATCHES=$(jq '.summary.mismatches' /tmp/verification.json)
if [ "$MISMATCHES" -gt 5 ]; then
  echo "ALERT: $MISMATCHES mismatches found"
  # Send alert via monitoring system
fi
```

### Prometheus Metrics Export

Future enhancement: Export verification results as Prometheus metrics:

```
tricklepay_verification_streams_total 1234
tricklepay_verification_matches_total 1230
tricklepay_verification_mismatches_total 3
tricklepay_verification_duration_seconds 45.3
tricklepay_verification_last_run_timestamp 1700000000
```

## Documentation Updates

### INDEXER_VERIFICATION.md

Add a section linking to the automated CLI:

```markdown
## Automated Verification

The manual procedure above can be automated using the verification CLI:

\`\`\`bash
# Verify all streams
npm run verify-streams

# Sample 100 random streams for quick check
npm run verify-streams -- --sample 100

# Output JSON for monitoring integration
npm run verify-streams -- --json --sample 50
\`\`\`

For complete CLI documentation, see [verification-cli-design.md](verification-cli-design.md).
```

### README.md

Add to the Scripts/CLI tools section:

```markdown
### Stream Verification

Verify indexed database state against on-chain state:

\`\`\`bash
# Verify all streams
npm run verify-streams

# Sample and output JSON
npm run verify-streams -- --sample 100 --json
\`\`\`

See [docs/verification-cli-design.md](docs/verification-cli-design.md) for details.
```

## Testing Strategy

### Unit Tests

- Field comparison logic with various data types
- Address normalization edge cases
- Sampling strategies return correct stream IDs
- Output formatters produce valid JSON and human-readable text

### Integration Tests

- Verify against mock RPC server with known state
- Test mismatch detection (inject differing values)
- Test missing stream scenarios (database-only, chain-only)
- Test error handling (RPC timeouts, connection failures)

### Manual Testing

Before release, verify against a live testnet deployment:
1. Run against known-good streams (should report 100% match)
2. Manually modify a database row and verify mismatch is detected
3. Test sampling strategies return expected distributions
4. Verify JSON output is valid and parseable

## Security Considerations

### Read-Only Operations

The tool performs **only read operations**:
- Database: `SELECT` queries via Prisma (no `UPDATE`, `INSERT`, `DELETE`)
- Chain: `get_stream()` queries via RPC (no contract invocations)
- No authentication or signing required

### RPC Endpoint Trust

The tool trusts the RPC endpoint configured in `SOROBAN_RPC_URL`:
- Verification results are only as trustworthy as the RPC provider
- For high-assurance verification, use multiple independent RPC endpoints and cross-check
- Future: Support `--rpc-url` override for verification against different providers

### Sensitive Data

Stream data (amounts, addresses) is not considered sensitive:
- All data is public on-chain
- No secrets or private keys involved
- Safe to log and export

## Future Enhancements

1. **Historical verification**: Compare database state at a specific past ledger
2. **Continuous monitoring mode**: Run verification loop on a schedule
3. **Multi-RPC cross-checking**: Query multiple RPC endpoints and flag inconsistencies
4. **Event log verification**: Compare `IndexedEvent` table against chain event history
5. **Automatic reconciliation**: Option to update database from chain when drift is detected (with confirmation)
6. **Verification reports**: Store verification history in database for trend analysis
7. **Slack/webhook notifications**: Alert operators when mismatches exceed threshold

## Open Questions

1. **Should verification update the database when drift is detected?**
   - **Proposal:** No, keep tool read-only. Operators manually investigate and use replay tools.

2. **How to handle cancelled streams where endTime was frozen?**
   - **Proposal:** Document this as expected difference, not a mismatch. Add `--strict` mode that flags it.

3. **Should the tool verify `IndexedEvent` table as well?**
   - **Proposal:** Phase 2 enhancement. Initial version focuses on `Stream` table only.

4. **What constitutes a "high-value" stream for sampling?**
   - **Proposal:** Top N by `totalAmount`. Add `--high-value-threshold` to customize.
