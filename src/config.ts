// Loads and validates configuration from the environment. A `.env` file in
// the working directory is read when present; otherwise the ambient
// environment is used, so the same code works in local dev and in production.

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
  bodyLimit: number;
  queryStringLimit: number;
}

export function loadConfig(): Config {
  const network = optional("NETWORK", "testnet");
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  if (!networkPassphrase) {
    throw new Error(`Unknown NETWORK "${network}"; expected "testnet" or "mainnet"`);
  }

  const rpcUrl = optional("SOROBAN_RPC_URL", DEFAULT_RPC_URLS[network]);
  validateRpcUrl(rpcUrl);

  return {
    port: integer("PORT", 3000),
    host: optional("HOST", "0.0.0.0"),
    databaseUrl: required("DATABASE_URL"),
    network,
    networkPassphrase,
    rpcUrl: optional("SOROBAN_RPC_URL", DEFAULT_RPC_URLS[network]),
    contractId: required("STREAM_CONTRACT_ID"),
    pollIntervalMs: integer("INDEXER_POLL_INTERVAL_MS", 5000),
    startLedger: integer("INDEXER_START_LEDGER", 0),
    bodyLimit: integer("BODY_LIMIT", 1048576), // 1MB default
    queryStringLimit: integer("QUERY_STRING_LIMIT", 2048), // 2KB default
  };
}
