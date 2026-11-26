# Load Testing

This guide explains how to run the load test for stream list endpoint query performance on a large table.

## Overview

The load test (`scripts/load-test-queries.ts`) validates that pagination, filters, and summary queries perform well at scale. It:

1. Seeds the database with 100,000 streams across diverse tokens, senders, and recipients
2. Measures query latencies (p50, p95, p99) for common endpoint patterns
3. Records results with the PostgreSQL version for comparison across environments

The test is designed to catch missing indexes and identify performance regressions before they reach production.

## Running the Load Test

### Prerequisites

- A running PostgreSQL instance (local or test environment)
- Database credentials configured in `.env` or environment variables
- Node.js 20+ and dependencies installed

### Command

```bash
npm run load-test
```

This will:
1. Clear any existing streams in the database
2. Seed 100,000 streams (takes ~30-60 seconds)
3. Run benchmark queries with warmup (takes ~2-3 minutes)
4. Print results with percentile latencies

### What Gets Tested

The load test measures the following query patterns:

| Query | Description | Threshold (p95) |
|-------|-------------|-----------------|
| **Unfiltered list** | `GET /streams?limit=50` (first page) | < 50ms |
| **Filtered by sender** | `GET /streams?sender=<address>&limit=50` | < 100ms |
| **Filtered by token** | `GET /streams?token=<address>&limit=50` | < 100ms |
| **Cursor pagination** | `GET /streams?cursor=<id>&limit=50` (deep page) | < 50ms |
| **Account summary** | `GET /accounts/<address>/summary` (aggregation) | < 200ms |

**Note:** Thresholds are advisory, not enforced in CI. They serve as guidelines for acceptable performance.

## Sample Output

```
Stream List Endpoint Load Test
============================================================

Connected to: PostgreSQL 16.1 on x86_64-pc-linux-gnu

Clearing existing streams...
Database cleared.
Seeding 100,000 streams...
  10,000 streams seeded (8.2s)
  20,000 streams seeded (16.5s)
  ...
Seeding completed in 52.3s

Running benchmarks...

1. Unfiltered list (limit 50, first page)
   p50: 12.34ms
   p95: 18.76ms
   p99: 24.11ms

2. Filtered by sender
   p50: 15.22ms
   p95: 28.45ms
   p99: 35.67ms

3. Filtered by token
   p50: 14.88ms
   p95: 26.91ms
   p99: 33.22ms

4. Cursor-based pagination (page at cursor 50,000)
   p50: 11.55ms
   p95: 17.33ms
   p99: 22.10ms

5. Account summary (aggregation)
   p50: 45.67ms
   p95: 78.90ms
   p99: 95.44ms

============================================================
LOAD TEST RESULTS
============================================================
Database: PostgreSQL 16.1 on x86_64-pc-linux-gnu
Total streams: 100,000
Warmup queries: 10
Benchmark queries: 100

Advisory performance thresholds (not enforced in CI):
  - Unfiltered list p95: < 50ms
  - Filtered list p95: < 100ms
  - Cursor pagination p95: < 50ms
  - Account summary p95: < 200ms

If queries exceed these thresholds, check for missing indexes.
============================================================
```

## Interpreting Results

### Good Performance

All p95 latencies are below the advisory thresholds. The database has appropriate indexes and can handle production load.

### Degraded Performance

If any p95 latency significantly exceeds its threshold:

1. **Check indexes:** Run `\d+ Stream` in `psql` to see existing indexes. The load test assumes these indexes exist:
   - `Stream_sender_streamId_idx` on `(sender, streamId DESC)`
   - `Stream_recipient_streamId_idx` on `(recipient, streamId DESC)`
   - `Stream_token_streamId_idx` on `(token, streamId DESC)`

2. **Check database resources:** Slow queries may indicate CPU, memory, or disk I/O constraints on the PostgreSQL server.

3. **Check for table bloat:** After many inserts/updates, run `VACUUM ANALYZE Stream;` to reclaim space and update statistics.

4. **Review query plans:** Use `EXPLAIN ANALYZE` on slow queries to see if indexes are being used:
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM "Stream"
   WHERE sender = 'SENDER000...'
   ORDER BY sender ASC, "streamId" DESC
   LIMIT 50;
   ```

### Recording Results

After running the load test, record the results in a tracking document or issue comment with:
- PostgreSQL version
- Hardware specs (CPU, RAM, disk type)
- p95 latencies for each query pattern

This allows comparison across environments and over time as the codebase evolves.

## Why 100,000 Streams?

This size is representative of a production workload:
- Large enough to reveal missing indexes (small tables fit in cache and mask problems)
- Small enough to seed and benchmark in a few minutes locally
- Matches the scale of the TricklePay testnet deployment at launch

If production grows beyond 100,000 streams, rerun the load test with a higher `TOTAL_STREAMS` value in `scripts/load-test-queries.ts` to validate performance at the new scale.

## CI and Automation

The load test is **not** run in CI by default because:
- It requires a dedicated database instance
- Seeding and benchmarking takes several minutes
- Latency results vary by hardware and are not stable across CI runners

It is intended to be run locally or in a staging environment before major releases.

To automate it, consider:
- Running it nightly against a test database
- Alerting if p95 latencies exceed thresholds by >50%
- Recording results to a time-series database for trend analysis

## Cleanup

After running the load test, the seeded streams remain in the database. To remove them:

```bash
npx prisma migrate reset
```

This drops and recreates the database schema, removing all data. Only use in development.

## Customizing the Load Test

To adjust the test parameters, edit `scripts/load-test-queries.ts`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TOTAL_STREAMS` | 100,000 | Number of streams to seed |
| `BATCH_SIZE` | 1,000 | Streams inserted per transaction |
| `WARMUP_QUERIES` | 10 | Queries to run before timing (primes cache) |
| `BENCHMARK_QUERIES` | 100 | Queries to time for percentile calculation |

After changing these, rerun `npm run load-test` to apply the new configuration.

## Related Documentation

- [Database Schema](database-schema.md) — Table structure and indexes
- [Database Migrations](database-migrations.md) — How to add or modify indexes
- [Query Parameters](query-parameters.md) — Endpoint filter semantics
