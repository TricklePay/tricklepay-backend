// Loads and validates configuration from the environment. A `.env` file in
// the working directory is read when present; otherwise the ambient
// environment is used, so the same code works in local dev and in production.

import { StrKey } from "@stellar/stellar-sdk";
import { parseTrustedProxies } from "./proxy.js";

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

// Floor for the poll interval. Anything smaller makes the indexer spin on the
// RPC between ledgers, so values below it are rejected rather than trusted.
export const MIN_POLL_INTERVAL_MS = 1000;

// Default cap on event pages fetched per poll tick. A backlog is split across
// ticks so a single poll cannot run indefinitely, but the default is high enough
// that a normal catch-up drains in one tick.
export const DEFAULT_MAX_PAGES_PER_TICK = 1000;

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

// Returns true when the URL resolves to a loopback address (localhost or
// 127.x.x.x). These are the only hosts for which plain HTTP is acceptable.
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname.startsWith("127.");
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
        `Remote endpoints must use HTTPS. Use http:// only for localhost or 127.x.x.x.`,
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

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  contractId: string;
  pollIntervalMs: number;
  startLedger: number;
  maxPagesPerTick: number;
  bodyLimit: number;
  queryStringLimit: number;
  trustedProxies: string[];
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

  return {
    port: integer("PORT", 3000),
    host: optional("HOST", "0.0.0.0"),
    databaseUrl: required("DATABASE_URL"),
    network,
    networkPassphrase,
    rpcUrl,
    contractId,
    pollIntervalMs: positiveInteger("INDEXER_POLL_INTERVAL_MS", 5000, MIN_POLL_INTERVAL_MS),
    startLedger: integer("INDEXER_START_LEDGER", 0),
    maxPagesPerTick: positiveInteger(
      "INDEXER_MAX_PAGES_PER_TICK",
      DEFAULT_MAX_PAGES_PER_TICK,
      1,
    ),
    bodyLimit: integer("BODY_LIMIT", 1048576), // 1MB default
    queryStringLimit: integer("QUERY_STRING_LIMIT", 2048), // 2KB default
    // Forwarded headers are honored only for these direct peers (#75).
    trustedProxies: parseTrustedProxies(process.env.TRUSTED_PROXIES),
  };
}
