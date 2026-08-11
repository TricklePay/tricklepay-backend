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
}

export function loadConfig(): Config {
  const network = optional("NETWORK", "testnet");
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  if (!networkPassphrase) {
    throw new Error(`Unknown NETWORK "${network}"; expected "testnet" or "mainnet"`);
  }

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
  };
}
