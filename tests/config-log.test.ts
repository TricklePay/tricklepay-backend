import { describe, expect, it } from "vitest";

import { type Config, describeConfig, redactDatabaseUrl } from "../src/config.js";

// The startup configuration line (#474) is the answer to "what did this process
// actually start with?", so it has to be complete and it has to be safe to
// paste into an issue: every field of `Config` appears, and the database
// credentials do not.

const CONFIG: Config = {
  port: 3000,
  host: "0.0.0.0",
  publicBaseUrl: "https://api.tricklepay.example",
  databaseUrl: "postgresql://indexer:s3cr3t@db.internal:5432/tricklepay?schema=public",
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW",
  pollIntervalMs: 5000,
  startLedger: 0,
  maxBackoffMs: 60000,
  maxPagesPerTick: 1000,
  summaryCacheTtlMs: 2000,
  bodyLimit: 1048576,
  queryStringLimit: 2048,
  compressionThresholdBytes: 1024,
  trustedProxies: ["10.0.0.0/8"],
  rateLimitAllowlist: [],
  rateLimitMax: 100,
  rateLimitWindowMs: 60000,
  readyMaxStalenessMs: 0,
  readinessRetryAfterSeconds: 5,
  enableDocsUi: true,
};

// Kept as a literal rather than derived from `describeConfig`, so that adding a
// field to `Config` without deciding how it is logged fails here as well as in
// the type checker.
const EXPECTED_FIELDS = [
  "bodyLimit",
  "compressionThresholdBytes",
  "connectionTimeoutMs",
  "contractId",
  "databaseUrl",
  "enableDocsUi",
  "host",
  "keepAliveTimeoutMs",
  "maxBackoffMs",
  "maxPagesPerTick",
  "maxTrackedRateLimitClients",
  "metricsToken",
  "network",
  "networkPassphrase",
  "pollIntervalMs",
  "port",
  "publicBaseUrl",
  "queryStringLimit",
  "rateLimitAllowlist",
  "rateLimitMax",
  "rateLimitWindowMs",
  "readinessRetryAfterSeconds",
  "readyMaxStalenessMs",
  "requestTimeoutMs",
  "rpcUrl",
  "startLedger",
  "summaryCacheTtlMs",
  "trustedProxies",
];

describe("redactDatabaseUrl", () => {
  it("replaces the user and password but keeps the server it points at", () => {
    const redacted = redactDatabaseUrl(
      "postgresql://indexer:s3cr3t@db.internal:5432/tricklepay?schema=public",
    );

    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toContain("indexer");
    expect(redacted).toContain("db.internal:5432");
    expect(redacted).toContain("/tricklepay");
    expect(redacted).toContain("schema=public");
  });

  it("redacts a password passed as a query parameter", () => {
    const redacted = redactDatabaseUrl("postgresql://db.internal:5432/tricklepay?password=s3cr3t");

    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).toContain("password=***");
  });

  it("leaves a URL without credentials intact", () => {
    expect(redactDatabaseUrl("postgresql://localhost:5432/test")).toBe(
      "postgresql://localhost:5432/test",
    );
  });

  it("redacts a value it cannot parse rather than guessing", () => {
    // A malformed DSN could hold a password anywhere in it, so none of it is
    // logged.
    expect(redactDatabaseUrl("indexer:s3cr3t@db.internal/tricklepay")).not.toContain("s3cr3t");
  });
});

describe("describeConfig", () => {
  it("covers every field of Config", () => {
    expect(Object.keys(describeConfig(CONFIG)).sort()).toEqual(EXPECTED_FIELDS);
  });

  it("reports the resolved values unchanged apart from the database URL", () => {
    const described = describeConfig(CONFIG);

    expect(described).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: CONFIG.contractId,
      pollIntervalMs: 5000,
      startLedger: 0,
      maxBackoffMs: 60000,
      maxPagesPerTick: 1000,
      summaryCacheTtlMs: 2000,
      bodyLimit: 1048576,
      queryStringLimit: 2048,
      trustedProxies: ["10.0.0.0/8"],
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
    });
  });

  it("names the optional rate-limit fields even when they are unset", () => {
    const { rateLimitMax: _max, rateLimitWindowMs: _window, ...rest } = CONFIG;
    const described = describeConfig(rest);

    expect(Object.keys(described).sort()).toEqual(EXPECTED_FIELDS);
    expect(described.rateLimitMax).toBeUndefined();
    expect(described.rateLimitWindowMs).toBeUndefined();
  });

  it("carries no credentials anywhere in the logged object", () => {
    expect(JSON.stringify(describeConfig(CONFIG))).not.toContain("s3cr3t");
  });

  it("redacts a configured metrics token rather than logging it", () => {
    const described = describeConfig({ ...CONFIG, metricsToken: "top-s3cret" });

    expect(described.metricsToken).toBe("[redacted]");
    expect(JSON.stringify(described)).not.toContain("top-s3cret");
  });
});
