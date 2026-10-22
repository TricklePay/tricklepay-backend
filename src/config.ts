// Loads and validates configuration from the environment. A `.env` file in
// the working directory is read when present; otherwise the ambient
// environment is used, so the same code works in local dev and in production.

import { StrKey } from "@stellar/stellar-sdk";

import { parseTrustedProxies, parseAllowlist } from "./proxy.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file found; rely on the ambient environment.
}

const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

const DEFAULT_RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer`);
  }
  return parsed;
}

// Parses a boolean flag. Only explicit true/false spellings are accepted so a
// typo fails at startup instead of silently flipping a security-relevant
// setting, such as whether the interactive docs are served.
function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`Environment variable ${name} must be "true" or "false"`);
}

// Floor for the poll interval. Anything smaller makes the indexer spin on the
// RPC between ledgers, so values below it are rejected rather than trusted.
export const MIN_POLL_INTERVAL_MS = 1000;

// Default ceiling on the exponential poll backoff. After repeated RPC failures
// the retry delay doubles each time up to this value; a successful poll resets
// it to the normal poll interval. 60s keeps a stalled indexer from hammering an
// unavailable RPC while still recovering promptly.
export const DEFAULT_MAX_BACKOFF_MS = 60000;

// Default cap on event pages fetched per poll tick. A backlog is split across
// ticks so a single poll cannot run indefinitely, but the default is high enough
// that a normal catch-up drains in one tick.
export const DEFAULT_MAX_PAGES_PER_TICK = 1000;

// Summary aggregates are expensive and commonly polled, so cache them briefly.
export const DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS = 2_000;

// Default maximum allowed staleness for the indexer position reported by /ready.
// 0 means disabled (no staleness check).
export const DEFAULT_READY_MAX_STALENESS_MS = 0;

// Default request rate limit: 100 requests per client IP per 60-second
// window, matching docs/request-size-limits.md. Used by loadConfig below and
// by server.ts when registering the rate-limit plugin.
export const DEFAULT_RATE_LIMIT_MAX = 100;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 72_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Default Retry-After, in seconds, advertised on a not-ready `/ready`
// response. It tells orchestrators and load balancers how long to wait before
// probing again, which is useful while a long backfill is still in progress.
export const DEFAULT_READINESS_RETRY_AFTER_SECONDS = 5;

// Responses at or above this many bytes are compressed when the client accepts
// gzip or brotli. List responses with many streams are large and highly
// repetitive, so compressing them cuts transfer size substantially; smaller
// responses are left alone, since the encoding overhead would outweigh the
// saving. Used by server.ts when registering @fastify/compress.
export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024;

function positiveInteger(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  if (parsed < min) {
    throw new Error(
      `Environment variable ${name} must be at least ${min}; a smaller interval would hammer the RPC`,
    );
  }
  return parsed;
}

// Returns true when the URL resolves to a loopback address: localhost, an
// IPv4 address in the 127.0.0.0/8 loopback range, or the IPv6 loopback ::1.
// These are the only hosts for which plain HTTP is acceptable. The hostname
// must be a *loopback address itself*; a public hostname that merely begins
// with "127." (e.g. 127.evil.com) is not local, so it cannot be reached over
// plain HTTP.
export function isLocalUrl(url: string): boolean {
  try {
    // WHATWG URLs keep the brackets in the hostname of IPv6 literals, so
    // http://[::1]:8000 yields "[::1]".
    const { hostname } = new URL(url);
    if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") {
      return true;
    }
    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets[0] === "127" &&
      octets.slice(1).every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

// Validates that plain HTTP is only used for local endpoints. Throws at config
// load time so a misconfigured SOROBAN_RPC_URL never silently downgrades a
// production node.
function validateRpcUrl(url: string): void {
  if (url.startsWith("http://") && !isLocalUrl(url)) {
    throw new Error(
      `SOROBAN_RPC_URL "${url}" uses plain HTTP on a non-local host. ` +
      `Remote endpoints must use HTTPS. Use http:// only for localhost, 127.x.x.x or [::1].`,
    );
  }
}

// Validates the contract id parses as a Soroban contract address (a StrKey
// contract id starting with "C"). A typo here previously surfaced only later as
// confusing RPC failures; catching it while loading configuration fails fast
// instead, before the server or indexer starts.
function validateContractId(contractId: string): void {
  if (!StrKey.isValidContract(contractId)) {
    throw new Error(
      `STREAM_CONTRACT_ID "${contractId}" is not a valid Soroban contract address. ` +
      `Expected a 56-character StrKey contract id starting with "C".`,
    );
  }
}

// Validates connection pool settings in the DATABASE_URL if present. Prisma reads
// connection_limit and pool_timeout from query parameters, so invalid values surface
// as runtime failures. Validating them at startup catches misconfigurations early.
function validateDatabaseUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const connectionLimit = parsed.searchParams.get("connection_limit");
    const poolTimeout = parsed.searchParams.get("pool_timeout");

    if (connectionLimit !== null) {
      const limit = Number(connectionLimit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(
          `DATABASE_URL connection_limit must be a positive integer, got "${connectionLimit}". ` +
            `Example: postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=10`,
        );
      }
    }

    if (poolTimeout !== null) {
      const timeout = Number(poolTimeout);
      if (!Number.isInteger(timeout) || timeout < 1) {
        throw new Error(
          `DATABASE_URL pool_timeout must be a positive integer (seconds), got "${poolTimeout}". ` +
            `Example: postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=10`,
        );
      }
    }
  } catch (err) {
    // Re-throw validation errors as-is
    if (err instanceof Error && err.message.startsWith("DATABASE_URL")) {
      throw err;
    }
    // URL parsing failures surface as-is; invalid schemes or malformed URLs
    // will fail when Prisma tries to connect anyway.
  }
}

// Rejects a configured start ledger that is beyond the current chain head.
// Such a value would leave the indexer waiting forever with no events, which
// looks identical to a broken RPC endpoint, so it is rejected at startup with
// a message that explains the problem.
export function validateStartLedger(startLedger: number, chainHead: number): void {
  if (startLedger > chainHead) {
    throw new Error(
      `INDEXER_START_LEDGER ${startLedger} is beyond the chain head ${chainHead}. ` +
      `The indexer would wait forever with no events. Set INDEXER_START_LEDGER to ${chainHead} or lower.`,
    );
  }
}

// Builds the base URL a client generator should use when the OpenAPI document
// does not carry an explicit one. The configured bind address is often a
// wildcard (`0.0.0.0` or `::`) that a client cannot dial, so it is replaced
// with `localhost` for the default; deployments that sit behind a hostname or
// proxy set PUBLIC_BASE_URL explicitly.
export function defaultPublicBaseUrl(host: string, port: number): string {
  const dialableHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  // An IPv6 literal must be bracketed to parse as a URL authority.
  const authority = dialableHost.includes(":") ? `[${dialableHost}]` : dialableHost;
  return `http://${authority}:${port}`;
}

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly publicBaseUrl: string;
  readonly databaseUrl: string;
  readonly network: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly contractId: string;
  readonly pollIntervalMs: number;
  readonly startLedger: number;
  readonly maxBackoffMs: number;
  readonly maxPagesPerTick: number;
  readonly summaryCacheTtlMs: number;
  readonly bodyLimit: number;
  readonly queryStringLimit: number;
  readonly compressionThresholdBytes: number;
  readonly connectionTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly trustedProxies: readonly string[];
  readonly rateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
  readonly readyMaxStalenessMs: number;
  readonly rateLimitAllowlist: readonly string[];
  readonly maxTrackedRateLimitClients?: number;
  readonly readinessRetryAfterSeconds: number;
  // Optional bearer token for the metrics endpoint. When set, /metrics requires
  // a matching Bearer token; when unset it is unauthenticated.
  readonly metricsToken?: string;
  // Whether to serve the interactive Swagger UI at /docs. When false, only
  // /docs/json and /docs/yaml are available. Default: true.
  readonly enableDocsUi: boolean;
}

export function loadConfig(): Config {
  const network = optional("NETWORK", "testnet");
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  if (!networkPassphrase) {
    throw new Error(`Unknown NETWORK "${network}"; expected "testnet" or "mainnet"`);
  }

  const rpcUrl = optional("SOROBAN_RPC_URL", DEFAULT_RPC_URLS[network]);
  validateRpcUrl(rpcUrl);

  const contractId = required("STREAM_CONTRACT_ID");
  validateContractId(contractId);

  const databaseUrl = required("DATABASE_URL");
  validateDatabaseUrl(databaseUrl);

  const rateLimitMax = integer("RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT_MAX);
  if (rateLimitMax === 0) {
    throw new Error("RATE_LIMIT_MAX must be greater than zero");
  }
  const rateLimitWindowMs = integer("RATE_LIMIT_WINDOW_MS", DEFAULT_RATE_LIMIT_WINDOW_MS);
  if (rateLimitWindowMs === 0) {
    throw new Error("RATE_LIMIT_WINDOW_MS must be greater than zero");
  }
  const readinessRetryAfterSeconds = integer(
    "READINESS_RETRY_AFTER_SECONDS",
    DEFAULT_READINESS_RETRY_AFTER_SECONDS,
  );

  const port = integer("PORT", 3000);
  const host = optional("HOST", "0.0.0.0");

  return {
    port,
    host,
    publicBaseUrl: optional("PUBLIC_BASE_URL", defaultPublicBaseUrl(host, port)),
    databaseUrl: required("DATABASE_URL"),
    network,
    networkPassphrase,
    rpcUrl,
    contractId,
    pollIntervalMs: positiveInteger("INDEXER_POLL_INTERVAL_MS", 5000, MIN_POLL_INTERVAL_MS),
    startLedger: integer("INDEXER_START_LEDGER", 0),
    maxBackoffMs: positiveInteger(
      "INDEXER_BACKOFF_MAX_MS",
      DEFAULT_MAX_BACKOFF_MS,
      MIN_POLL_INTERVAL_MS,
    ),
    maxPagesPerTick: positiveInteger(
      "INDEXER_MAX_PAGES_PER_TICK",
      DEFAULT_MAX_PAGES_PER_TICK,
      1,
    ),
    summaryCacheTtlMs: integer(
      "STREAM_SUMMARY_CACHE_TTL_MS",
      DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS,
    ),
    bodyLimit: integer("BODY_LIMIT", 1048576), // 1MB default
    queryStringLimit: integer("QUERY_STRING_LIMIT", 2048), // 2KB default
    connectionTimeoutMs: integer("CONNECTION_TIMEOUT_MS", DEFAULT_CONNECTION_TIMEOUT_MS),
    keepAliveTimeoutMs: integer("KEEP_ALIVE_TIMEOUT_MS", DEFAULT_KEEP_ALIVE_TIMEOUT_MS),
    requestTimeoutMs: integer("REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
    compressionThresholdBytes: integer(
      "COMPRESSION_THRESHOLD_BYTES",
      DEFAULT_COMPRESSION_THRESHOLD_BYTES,
    ),
    // Forwarded headers are honored only for these direct peers (#75).
    trustedProxies: parseTrustedProxies(process.env.TRUSTED_PROXIES),
    rateLimitMax,
    rateLimitWindowMs,
    // Staleness threshold for the /ready endpoint. 0 = disabled.
    readyMaxStalenessMs: integer("READY_MAX_STALENESS_MS", DEFAULT_READY_MAX_STALENESS_MS),
    // Addresses that bypass the rate limiter entirely (#allowlist).
    rateLimitAllowlist: parseAllowlist(process.env.RATE_LIMIT_ALLOWLIST),
    readinessRetryAfterSeconds,
    // An empty value means "no token", preserving the unauthenticated default.
    metricsToken: process.env.METRICS_TOKEN?.trim() || undefined,
    // The UI is on by default; ENABLE_DOCS_UI=false serves only the spec.
    enableDocsUi: boolean("ENABLE_DOCS_UI", true),
  };
}

// ---------------------------------------------------------------------------
// Startup reporting (#474).
//
// When the service misbehaves the first question is what configuration it
// actually started with, and the answer is spread across the defaults above, a
// `.env` file, and the ambient environment. `describeConfig` renders the
// resolved values for a single startup log line, with the database credentials
// removed.
// ---------------------------------------------------------------------------

// Query parameters that carry a secret in a Postgres connection string.
const CREDENTIAL_QUERY_PARAMS = ["password", "sslpassword"];

// Replaces the credentials in a database URL with a placeholder, keeping the
// parts that identify the server (scheme, host, port, database) so the line
// still answers "which database is this pointed at?".
export function redactDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Nothing can be said about where credentials sit in a value that is not a
    // URL, so none of it is logged.
    return "[unparseable, redacted]";
  }

  // A value with no authority component ("indexer:secret@host/db", which parses
  // as an opaque "indexer:" URL) has no field to redact, and the secret in it
  // would otherwise pass through untouched.
  if (parsed.host === "") return "[unparseable, redacted]";

  if (parsed.username !== "") parsed.username = "***";
  if (parsed.password !== "") parsed.password = "***";
  for (const param of CREDENTIAL_QUERY_PARAMS) {
    if (parsed.searchParams.has(param)) parsed.searchParams.set(param, "***");
  }

  return parsed.toString();
}

// The configuration as it is logged: every field of `Config`, with the
// database URL narrowed to its redacted rendering. Mapped over `keyof Config`
// so a field added to `Config` fails to type check until it is given a place
// here, which keeps the startup line from quietly falling behind.
// Mapped over `Required<Config>` rather than `Config`, so a field `Config`
// declares optional (the rate-limit settings) still has to be named below
// instead of silently dropping out of the line; the value may still be
// undefined, which pino omits from the output.
export type LoggedConfig = {
  [K in keyof Required<Config>]: K extends "databaseUrl" ? string : Config[K] | undefined;
};

export function describeConfig(config: Config): LoggedConfig {
  return {
    port: config.port,
    connectionTimeoutMs: config.connectionTimeoutMs,
    keepAliveTimeoutMs: config.keepAliveTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    host: config.host,
    publicBaseUrl: config.publicBaseUrl,
    // The only field carrying a secret.
    databaseUrl: redactDatabaseUrl(config.databaseUrl),
    network: config.network,
    networkPassphrase: config.networkPassphrase,
    rpcUrl: config.rpcUrl,
    contractId: config.contractId,
    pollIntervalMs: config.pollIntervalMs,
    startLedger: config.startLedger,
    maxBackoffMs: config.maxBackoffMs,
    maxPagesPerTick: config.maxPagesPerTick,
    summaryCacheTtlMs: config.summaryCacheTtlMs,
    bodyLimit: config.bodyLimit,
    queryStringLimit: config.queryStringLimit,
    compressionThresholdBytes: config.compressionThresholdBytes,
    trustedProxies: config.trustedProxies,
    // Undefined when rate limiting is not configured; pino omits the field.
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    readyMaxStalenessMs: config.readyMaxStalenessMs,
    rateLimitAllowlist: config.rateLimitAllowlist,
    maxTrackedRateLimitClients: config.maxTrackedRateLimitClients,
    // Never log the secret itself, only whether one is configured.
    metricsToken: config.metricsToken ? "[redacted]" : undefined,
    enableDocsUi: config.enableDocsUi,
    readinessRetryAfterSeconds: config.readinessRetryAfterSeconds,
  };
}
