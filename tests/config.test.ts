import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_MAX_PAGES_PER_TICK,
  MIN_POLL_INTERVAL_MS,
  isLocalUrl,
  loadConfig,
} from "../src/config.js";

// `isLocalUrl` is tested in isolation first, then `loadConfig` is exercised
// to confirm the validation fires at the right place with a readable message.
// The ambient environment is patched per test so the module-level loadEnvFile
// call does not interfere.

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://localhost:5432/test",
  STREAM_CONTRACT_ID: "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW",
  NETWORK: "testnet",
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys({ ...BASE_ENV, ...overrides })) {
    saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("isLocalUrl", () => {
  it("accepts localhost", () => {
    expect(isLocalUrl("http://localhost:8000")).toBe(true);
  });

  it("accepts 127.0.0.1", () => {
    expect(isLocalUrl("http://127.0.0.1:8000")).toBe(true);
  });

  it("accepts other 127.x.x.x addresses", () => {
    expect(isLocalUrl("http://127.0.0.2:8000")).toBe(true);
    expect(isLocalUrl("http://127.1.2.3")).toBe(true);
  });

  it("rejects a public hostname", () => {
    expect(isLocalUrl("http://soroban-testnet.stellar.org")).toBe(false);
  });

  it("rejects an IP address outside loopback range", () => {
    expect(isLocalUrl("http://192.168.1.1")).toBe(false);
    expect(isLocalUrl("http://10.0.0.1")).toBe(false);
  });

  it("returns false for a malformed URL", () => {
    expect(isLocalUrl("not-a-url")).toBe(false);
  });

  it("is not confused by a hostname that merely contains '127'", () => {
    expect(isLocalUrl("http://host127.example.com")).toBe(false);
  });
});

describe("loadConfig — default values for unset optional settings", () => {
  it("uses the documented defaults for every optional value", () => {
    withEnv(
      {
        NETWORK: undefined,
        SOROBAN_RPC_URL: undefined,
        PORT: undefined,
        HOST: undefined,
        BODY_LIMIT: undefined,
        QUERY_STRING_LIMIT: undefined,
        INDEXER_POLL_INTERVAL_MS: undefined,
        INDEXER_START_LEDGER: undefined,
        INDEXER_BACKOFF_MAX_MS: undefined,
        INDEXER_MAX_PAGES_PER_TICK: undefined,
        TRUSTED_PROXIES: undefined,
      },
      () => {
        expect(loadConfig()).toMatchObject({
          network: "testnet",
          rpcUrl: "https://soroban-testnet.stellar.org",
          port: 3000,
          host: "0.0.0.0",
          pollIntervalMs: 5000,
          startLedger: 0,
          maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
          maxPagesPerTick: DEFAULT_MAX_PAGES_PER_TICK,
          bodyLimit: 1048576,
          queryStringLimit: 2048,
          trustedProxies: [],
        });
      },
    );
  });

  it("switches the default RPC URL to the selected network", () => {
    withEnv({ NETWORK: "mainnet", SOROBAN_RPC_URL: undefined }, () => {
      expect(loadConfig()).toMatchObject({
        network: "mainnet",
        rpcUrl: "https://mainnet.sorobanrpc.com",
      });
    });
  });
});

describe("loadConfig — RPC URL validation", () => {
  it("accepts an https:// URL for a remote host", () => {
    withEnv({ SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org" }, () => {
      expect(() => loadConfig()).not.toThrow();
    });
  });

  it("accepts http:// for localhost", () => {
    withEnv({ SOROBAN_RPC_URL: "http://localhost:8000" }, () => {
      expect(() => loadConfig()).not.toThrow();
    });
  });

  it("accepts http:// for 127.0.0.1", () => {
    withEnv({ SOROBAN_RPC_URL: "http://127.0.0.1:8000" }, () => {
      expect(() => loadConfig()).not.toThrow();
    });
  });

  it("rejects a remote http:// URL with a clear message", () => {
    const badUrl = "http://soroban-testnet.stellar.org";
    withEnv({ SOROBAN_RPC_URL: badUrl }, () => {
      expect(() => loadConfig()).toThrow(
        `SOROBAN_RPC_URL "${badUrl}" uses plain HTTP on a non-local host.`,
      );
    });
  });

  it("includes the offending URL in the error message", () => {
    const badUrl = "http://mainnet.sorobanrpc.com";
    withEnv({ SOROBAN_RPC_URL: badUrl }, () => {
      expect(() => loadConfig()).toThrow(badUrl);
    });
  });

  it("mentions HTTPS in the error message", () => {
    withEnv({ SOROBAN_RPC_URL: "http://example.com" }, () => {
      expect(() => loadConfig()).toThrow(/HTTPS/);
    });
  });
});

describe("loadConfig — STREAM_CONTRACT_ID validation", () => {
  it("accepts a valid contract id unchanged", () => {
    const valid = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
    withEnv({ STREAM_CONTRACT_ID: valid }, () => {
      expect(loadConfig().contractId).toBe(valid);
    });
  });

  it("rejects a missing contract id before the server starts", () => {
    withEnv({ STREAM_CONTRACT_ID: undefined }, () => {
      expect(() => loadConfig()).toThrow(
        "Missing required environment variable: STREAM_CONTRACT_ID",
      );
    });
  });

  it("rejects an account address (G…) that is not a contract id", () => {
    const accountId = "GAHNMOIKVQNJMKYU34HLJZLJYLEEMODDCMLLI5ZMTA7RCVWVIVOPZZZT";
    withEnv({ STREAM_CONTRACT_ID: accountId }, () => {
      expect(() => loadConfig()).toThrow(
        `STREAM_CONTRACT_ID "${accountId}" is not a valid Soroban contract address`,
      );
    });
  });

  it("rejects a value that is not a StrKey at all", () => {
    withEnv({ STREAM_CONTRACT_ID: "my-contract" }, () => {
      expect(() => loadConfig()).toThrow(/not a valid Soroban contract address/);
    });
  });

  it("rejects a truncated id whose base32 checksum cannot decode", () => {
    withEnv({ STREAM_CONTRACT_ID: "CDMB62RVYAXJJNYYH7K442SH" }, () => {
      expect(() => loadConfig()).toThrow(/not a valid Soroban contract address/);
    });
  });

  it("names the setting in the rejection message", () => {
    withEnv({ STREAM_CONTRACT_ID: "hello" }, () => {
      expect(() => loadConfig()).toThrow(/^STREAM_CONTRACT_ID /);
    });
  });
});

describe("loadConfig — INDEXER_POLL_INTERVAL_MS bounds", () => {
  it("keeps the 5000 default when omitted or blank", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: undefined }, () => {
      expect(loadConfig().pollIntervalMs).toBe(5000);
    });
    withEnv({ INDEXER_POLL_INTERVAL_MS: "   " }, () => {
      expect(loadConfig().pollIntervalMs).toBe(5000);
    });
  });

  it("accepts an ordinary interval", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: "5000" }, () => {
      expect(loadConfig().pollIntervalMs).toBe(5000);
    });
  });

  it("accepts exactly the minimum interval", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: String(MIN_POLL_INTERVAL_MS) }, () => {
      expect(loadConfig().pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
    });
  });

  it("rejects zero, which would busy-loop the indexer", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: "0" }, () => {
      expect(() => loadConfig()).toThrow(/INDEXER_POLL_INTERVAL_MS.*at least/);
    });
  });

  it("rejects intervals below the minimum", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: String(MIN_POLL_INTERVAL_MS - 1) }, () => {
      expect(() => loadConfig()).toThrow(
        `INDEXER_POLL_INTERVAL_MS must be at least ${MIN_POLL_INTERVAL_MS}`,
      );
    });
  });

  it("rejects negative intervals", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: "-1000" }, () => {
      expect(() => loadConfig()).toThrow(/INDEXER_POLL_INTERVAL_MS must be at least/);
    });
  });

  it("rejects non-integer values", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: "1.5" }, () => {
      expect(() => loadConfig()).toThrow("INDEXER_POLL_INTERVAL_MS must be an integer");
    });
  });

  it("rejects values that do not parse as numbers", () => {
    withEnv({ INDEXER_POLL_INTERVAL_MS: "soon" }, () => {
      expect(() => loadConfig()).toThrow("INDEXER_POLL_INTERVAL_MS must be an integer");
    });
  });
});

describe("loadConfig — INDEXER_START_LEDGER bounds", () => {
  it("keeps zero semantics when omitted or zero", () => {
    withEnv({ INDEXER_START_LEDGER: undefined }, () => {
      expect(loadConfig().startLedger).toBe(0);
    });
    withEnv({ INDEXER_START_LEDGER: "0" }, () => {
      expect(loadConfig().startLedger).toBe(0);
    });
  });

  it("accepts a positive backfill ledger", () => {
    withEnv({ INDEXER_START_LEDGER: "1234567" }, () => {
      expect(loadConfig().startLedger).toBe(1234567);
    });
  });

  it("rejects negative ledgers with an actionable message", () => {
    withEnv({ INDEXER_START_LEDGER: "-1" }, () => {
      expect(() => loadConfig()).toThrow(
        "INDEXER_START_LEDGER must be a non-negative integer",
      );
    });
  });

  it("rejects fractional ledgers", () => {
    withEnv({ INDEXER_START_LEDGER: "12.5" }, () => {
      expect(() => loadConfig()).toThrow(
        "INDEXER_START_LEDGER must be a non-negative integer",
      );
    });
  });

  it("rejects ledgers that do not parse as numbers", () => {
    withEnv({ INDEXER_START_LEDGER: "latest" }, () => {
      expect(() => loadConfig()).toThrow(
        "INDEXER_START_LEDGER must be a non-negative integer",
      );
    });
  });
});

describe("loadConfig — INDEXER_BACKOFF_MAX_MS bounds", () => {
  it("keeps the default when omitted or blank", () => {
    withEnv({ INDEXER_BACKOFF_MAX_MS: undefined }, () => {
      expect(loadConfig().maxBackoffMs).toBe(DEFAULT_MAX_BACKOFF_MS);
    });
    withEnv({ INDEXER_BACKOFF_MAX_MS: "   " }, () => {
      expect(loadConfig().maxBackoffMs).toBe(DEFAULT_MAX_BACKOFF_MS);
    });
  });

  it("accepts an ordinary ceiling", () => {
    withEnv({ INDEXER_BACKOFF_MAX_MS: "30000" }, () => {
      expect(loadConfig().maxBackoffMs).toBe(30000);
    });
  });

  it("rejects zero, which would remove the backoff ceiling", () => {
    withEnv({ INDEXER_BACKOFF_MAX_MS: "0" }, () => {
      expect(() => loadConfig()).toThrow(/INDEXER_BACKOFF_MAX_MS.*at least/);
    });
  });

  it("rejects negative ceilings", () => {
    withEnv({ INDEXER_BACKOFF_MAX_MS: "-1" }, () => {
      expect(() => loadConfig()).toThrow(
        `INDEXER_BACKOFF_MAX_MS must be at least ${MIN_POLL_INTERVAL_MS}`,
      );
    });
  });

  it("rejects non-integer values", () => {
    withEnv({ INDEXER_BACKOFF_MAX_MS: "1.5" }, () => {
      expect(() => loadConfig()).toThrow("INDEXER_BACKOFF_MAX_MS must be an integer");
    });
  });

  it("rejects values that do not parse as numbers", () => {
    withEnv({ INDEXER_BACKOFF_MAX_MS: "long" }, () => {
      expect(() => loadConfig()).toThrow("INDEXER_BACKOFF_MAX_MS must be an integer");
    });
  });
});

describe("loadConfig — INDEXER_MAX_PAGES_PER_TICK bounds", () => {
  it("keeps the default when omitted or blank", () => {
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: undefined }, () => {
      expect(loadConfig().maxPagesPerTick).toBe(DEFAULT_MAX_PAGES_PER_TICK);
    });
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: "   " }, () => {
      expect(loadConfig().maxPagesPerTick).toBe(DEFAULT_MAX_PAGES_PER_TICK);
    });
  });

  it("accepts an ordinary limit", () => {
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: "500" }, () => {
      expect(loadConfig().maxPagesPerTick).toBe(500);
    });
  });

  it("accepts the minimum of one page", () => {
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: "1" }, () => {
      expect(loadConfig().maxPagesPerTick).toBe(1);
    });
  });

  it("rejects zero, which would stop the indexer before any progress", () => {
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: "0" }, () => {
      expect(() => loadConfig()).toThrow(/INDEXER_MAX_PAGES_PER_TICK.*at least/);
    });
  });

  it("rejects negative limits", () => {
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: "-1" }, () => {
      expect(() => loadConfig()).toThrow(
        `INDEXER_MAX_PAGES_PER_TICK must be at least 1`,
      );
    });
  });

  it("rejects non-integer values", () => {
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: "1.5" }, () => {
      expect(() => loadConfig()).toThrow("INDEXER_MAX_PAGES_PER_TICK must be an integer");
    });
  });

  it("rejects values that do not parse as numbers", () => {
    withEnv({ INDEXER_MAX_PAGES_PER_TICK: "many" }, () => {
      expect(() => loadConfig()).toThrow("INDEXER_MAX_PAGES_PER_TICK must be an integer");
    });
  });
});
