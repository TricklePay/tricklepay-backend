import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLocalUrl, loadConfig } from "../src/config.js";

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
