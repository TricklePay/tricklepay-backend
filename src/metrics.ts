// Minimal Prometheus exposition-format implementation. The project uses no
// metrics library to keep the dependency surface small; the Prometheus text
// format is simple enough that a single file covers everything needed.
//
// Supported metric types: Counter, Gauge, Histogram.
// All instances are registered in a shared registry and rendered by
// `renderMetrics()`, which produces the text/plain; version=0.0.4 body.

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  collect(): string;
}

const registry: Metric[] = [];

function register(m: Metric): void {
  registry.push(m);
}

// Renders all registered metrics in Prometheus exposition format.
export function renderMetrics(): string {
  return registry.map((m) => m.collect()).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

export class Counter {
  private values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {
    register({
      name,
      help,
      type: "counter",
      collect: () => this.serialize(),
    });
  }

  inc(labels: Record<string, string> = {}, amount = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  private serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name}_total 0`);
    } else {
      for (const [key, v] of this.values) {
        lines.push(`${this.name}_total${key} ${v}`);
      }
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

export class Gauge {
  private values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {
    register({
      name,
      help,
      type: "gauge",
      collect: () => this.serialize(),
    });
  }

  set(labels: Record<string, string>, value: number): void;
  set(value: number): void;
  set(labelsOrValue: Record<string, string> | number, value?: number): void {
    if (typeof labelsOrValue === "number") {
      this.values.set("", labelsOrValue);
    } else {
      this.values.set(labelsKey(labelsOrValue), value!);
    }
  }

  private serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, v] of this.values) {
        lines.push(`${this.name}${key} ${v}`);
      }
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

// Fixed upper bounds used for HTTP response time in milliseconds.
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export class Histogram {
  private buckets: number[];
  // Per-label-set state: counts per bucket, sum, total observations.
  private data = new Map<string, { counts: number[]; sum: number; total: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
    buckets: number[] = DEFAULT_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    register({
      name,
      help,
      type: "histogram",
      collect: () => this.serialize(),
    });
  }

  observe(labels: Record<string, string>, value: number): void {
    const key = labelsKey(labels);
    let entry = this.data.get(key);
    if (!entry) {
      entry = { counts: new Array<number>(this.buckets.length).fill(0), sum: 0, total: 0 };
      this.data.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.counts[i]++;
    }
    entry.sum += value;
    entry.total++;
  }

  private serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    // Emit a zero-observation set when nothing has been recorded yet so the
    // metric name at least appears in the output.
    const entries: [string, { counts: number[]; sum: number; total: number }][] =
      this.data.size > 0 ? [...this.data] : [["", { counts: new Array<number>(this.buckets.length).fill(0), sum: 0, total: 0 }]];

    for (const [key, entry] of entries) {
      // Cumulative counts: each bucket is the count of observations ≤ its le.
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.counts[i];
        const le = labelsWith(key, `le="${this.buckets[i]}"`);
        lines.push(`${this.name}_bucket${le} ${cumulative}`);
      }
      // +Inf bucket always equals the total.
      lines.push(`${this.name}_bucket${labelsWith(key, `le="+Inf"`)} ${entry.total}`);
      lines.push(`${this.name}_sum${key} ${entry.sum}`);
      lines.push(`${this.name}_count${key} ${entry.total}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

// Produces the `{k="v",...}` suffix from a plain object. An empty object
// returns an empty string so label-less metric lines render correctly.
function labelsKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${parts.join(",")}}`;
}

// Appends an extra `k="v"` pair into an existing label set string. Used by
// the histogram serializer to inject the `le` label alongside user labels.
function labelsWith(existing: string, extra: string): string {
  if (existing === "") return `{${extra}}`;
  // existing is already `{k="v",...}` — insert before the closing brace.
  return existing.slice(0, -1) + "," + extra + "}";
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// Exported metric instances
// ---------------------------------------------------------------------------

// Indexer -------------------------------------------------------------------

/** Total contract events decoded and applied to the database, by kind. */
export const eventsApplied = new Counter(
  "tricklepay_indexer_events_applied",
  "Total contract events applied to the database, by kind and outcome.",
  ["kind", "outcome"],
);

/** Number of ledgers the indexer is behind the chain's latest. */
export const indexerLagLedgers = new Gauge(
  "tricklepay_indexer_lag_ledgers",
  "Gap between the chain's latest ledger and the highest ledger the indexer has applied. -1 before the first poll.",
);

/** Total event pages fetched from the RPC. */
export const pagesFetched = new Counter(
  "tricklepay_indexer_pages_fetched",
  "Total event pages fetched from the Soroban RPC.",
);

/** Total RPC calls that returned an error. */
export const rpcErrors = new Counter(
  "tricklepay_rpc_errors",
  "Total Soroban RPC calls that resulted in an error.",
  ["operation"],
);

/** Total poll loop iterations that raised an unhandled error. */
export const pollErrors = new Counter(
  "tricklepay_indexer_poll_errors",
  "Total poll iterations that failed with an unhandled error.",
);

// HTTP ----------------------------------------------------------------------

/** HTTP request durations in milliseconds, by method and route. */
export const httpRequestDuration = new Histogram(
  "tricklepay_http_request_duration_ms",
  "HTTP request duration in milliseconds.",
  ["method", "route", "status"],
);

/** Total HTTP requests handled, by method, route, and status code. */
export const httpRequestsTotal = new Counter(
  "tricklepay_http_requests_total",
  "Total HTTP requests handled.",
  ["method", "route", "status"],
);
