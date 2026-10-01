# Adding a Metric

This guide explains how to add a new metric to the TricklePay backend. The service exposes Prometheus metrics at `/metrics` using a minimal, purpose-built implementation in `src/metrics.ts`.

## Overview

Metrics are registered by constructing one of the exported classes (`Counter`, `Gauge`, or `Histogram`) in `src/metrics.ts`. Each constructor registers a collector in a shared registry. When `/metrics` is scraped, all registered metrics are rendered in Prometheus text exposition format.

## Choosing a Metric Type

| Type | When to Use | Example |
|------|-------------|---------|
| **Counter** | Values that only increase (or reset to zero). Use for totals and rates. | Request counts, error counts, events processed |
| **Gauge** | Values that can increase or decrease freely. Use for current state or levels. | Current lag, active connections, queue depth |
| **Histogram** | Distributions of observed values (e.g., durations, sizes). Exports buckets, sum, and count. | Request duration, response size |

## Naming Conventions

All metric names MUST follow these rules:

1. **Use snake_case**: `tricklepay_indexer_events_applied`, not `tricklepayIndexerEventsApplied`.
2. **Start with `tricklepay_`**: Namespace prefix identifies metrics from this service.
3. **Include a subsystem**: `indexer`, `rpc`, `http`, or the relevant component.
4. **Describe the measured quantity**: Be specific about what the metric represents.
5. **Counters**: Name the event or total being counted (e.g., `events_applied`, `requests_total`). The `_total` suffix is added automatically by the serializer if not present.
6. **Gauges**: Name the current value being observed (e.g., `lag_ledgers`, `active_connections`).
7. **Histograms**: Name the quantity being distributed (e.g., `request_duration_ms`, `response_size_bytes`). Include the unit.

### Good Names

- `tricklepay_indexer_events_applied`
- `tricklepay_indexer_lag_ledgers`
- `tricklepay_http_request_duration_ms`
- `tricklepay_rpc_errors`

### Bad Names

- `tricklepayIndexerLag` (not snake_case, no subsystem)
- `events` (no namespace, too vague)
- `tricklepay_stuff` (not descriptive)

## Label Sets

Labels allow a single metric to be split into multiple time series. For example, `tricklepay_indexer_events_applied` has labels `kind` and `outcome` so you can query by event type.

### Bounded vs. Unbounded Labels

**Critical rule:** Label values MUST come from a **small, fixed set** of possibilities. Unbounded label values will **crash your metrics backend**.

#### ✅ Bounded (safe)

- `kind`: `"created"`, `"withdrawn"`, `"cancelled"` (3 known event types)
- `status`: `"200"`, `"404"`, `"500"` (HTTP status codes, bounded set)
- `outcome`: `"applied"`, `"duplicate"`, `"reconciled"`, `"missing"` (4 enum values)

#### ❌ Unbounded (dangerous)

- `streamId`: Unique per stream; millions of possible values → **millions of time series**
- `requestId`: UUID per request → **unbounded cardinality**
- `userId`: Arbitrary user identifier → **unbounded**
- `errorMessage`: Free-form error text → **unbounded**

**Why this matters:** Each unique combination of label values creates a separate time series. If you label by `streamId`, you get one time series per stream. After 100,000 streams, that's 100,000 series for one metric. Prometheus and similar systems will slow to a crawl or crash.

**What to do instead:**
- Count by type/category, not by identifier
- Use high-cardinality values in structured logs, not metrics
- Aggregate first: count errors by code, not by message

## Adding a New Metric

### Step 1: Declare the Metric in `src/metrics.ts`

Add your metric to the "Exported metric instances" section at the bottom of `src/metrics.ts`.

**Example: Adding a counter**
```typescript
/** Total database queries executed, by operation type. */
export const databaseQueriesTotal = new Counter(
  "tricklepay_database_queries_total",
  "Total database queries executed, by operation type.",
  ["operation"],
);
```

**Example: Adding a gauge**
```typescript
/** Current number of active indexer poll workers. */
export const activeIndexerWorkers = new Gauge(
  "tricklepay_indexer_active_workers",
  "Current number of active indexer poll workers.",
);
```

**Example: Adding a histogram**
```typescript
/** RPC call duration in milliseconds. */
export const rpcCallDuration = new Histogram(
  "tricklepay_rpc_call_duration_ms",
  "RPC call duration in milliseconds.",
  ["operation"],
);
```

### Step 2: Instrument Your Code

Import the metric where needed and call the appropriate method:

**Counter:**
```typescript
import { databaseQueriesTotal } from "./metrics.js";

// increment by 1
databaseQueriesTotal.inc({ operation: "insert" });

// increment by a specific amount
databaseQueriesTotal.inc({ operation: "select" }, 5);
```

**Gauge:**
```typescript
import { activeIndexerWorkers } from "./metrics.js";

// set to an exact value
activeIndexerWorkers.set(3);

// with labels
activeIndexerWorkers.set({ worker: "poll" }, 2);
```

**Histogram:**
```typescript
import { rpcCallDuration } from "./metrics.js";

const start = Date.now();
// ... perform RPC call
const duration = Date.now() - start;
rpcCallDuration.observe({ operation: "getEvents" }, duration);
```

### Step 3: Verify the Metric

Start the server and scrape `/metrics`:

```bash
curl http://localhost:3000/metrics | grep your_metric_name
```

You should see output like:

```
# HELP tricklepay_database_queries_total Total database queries executed, by operation type.
# TYPE tricklepay_database_queries_total counter
tricklepay_database_queries_total{operation="insert"} 42
tricklepay_database_queries_total{operation="select"} 100
```

## Histogram Buckets

Histograms use predefined buckets. The default buckets (defined in `src/metrics.ts`) are optimized for HTTP response times in milliseconds:

```
[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
```

If you need custom buckets, pass them as the fourth argument:

```typescript
export const customHistogram = new Histogram(
  "tricklepay_custom_duration_ms",
  "Custom duration histogram.",
  [],
  [10, 50, 100, 500, 1000], // custom buckets
);
```

## Database Query Duration

`tricklepay_database_query_duration_ms` records the duration of each Prisma SQL query in milliseconds. It is observed from Prisma query events in the shared client, so it includes query execution across API and indexer database operations. The histogram has no labels, keeping its series count fixed; use database logs or traces when individual query identification is needed.

## Testing

After adding a metric:

1. Run `npm run typecheck` to verify type safety
2. Run `npm test` to ensure existing tests pass
3. Start the server locally and verify the metric appears at `/metrics`
4. Generate sample data (trigger the instrumented code path)
5. Confirm the metric increments/updates as expected

## Common Pitfalls

1. **Using unbounded label values** → Use enums or bounded categories only
2. **Not including a subsystem in the name** → Always prefix with `tricklepay_<subsystem>_`
3. **Forgetting to export the metric** → The metric must be exported from `src/metrics.ts` to be registered
4. **Label order inconsistency** → Always pass labels in the same order for a given metric
5. **Mismatched label names** → The label names in the constructor must match the keys in `inc()`/`set()`/`observe()` calls

## Further Reading

- [Prometheus Naming Best Practices](https://prometheus.io/docs/practices/naming/)
- [Metric Types](https://prometheus.io/docs/concepts/metric_types/)
- [Instrumentation Guidelines](https://prometheus.io/docs/practices/instrumentation/)
