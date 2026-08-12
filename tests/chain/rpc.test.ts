import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { createRpcServer } from "../../src/chain/rpc.js";
import type { Config } from "../../src/config.js";

// `createRpcServer` wraps `rpc.Server` construction. The only behaviour under
// test here is the `allowHttp` flag: it must be true only for local http://
// URLs and false for everything else. The Server constructor itself is stubbed
// so no live network call is made.

// Capture the options passed to `rpc.Server` without running real networking.
const serverSpy = vi.spyOn(rpc, "Server").mockImplementation(function (
  this: rpc.Server,
  _url: string,
  _opts?: object,
) {
  return this;
} as unknown as typeof rpc.Server);

function configWith(rpcUrl: string): Config {
  return {
    rpcUrl,
    port: 3000,
    host: "0.0.0.0",
    databaseUrl: "postgresql://localhost/test",
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW",
    pollIntervalMs: 5000,
    startLedger: 0,
  };
}

describe("createRpcServer — allowHttp flag", () => {
  it("sets allowHttp=false for an https:// URL", () => {
    serverSpy.mockClear();
    createRpcServer(configWith("https://soroban-testnet.stellar.org"));
    expect(serverSpy).toHaveBeenCalledWith(
      "https://soroban-testnet.stellar.org",
      expect.objectContaining({ allowHttp: false }),
    );
  });

  it("sets allowHttp=true for http://localhost", () => {
    serverSpy.mockClear();
    createRpcServer(configWith("http://localhost:8000"));
    expect(serverSpy).toHaveBeenCalledWith(
      "http://localhost:8000",
      expect.objectContaining({ allowHttp: true }),
    );
  });

  it("sets allowHttp=true for http://127.0.0.1", () => {
    serverSpy.mockClear();
    createRpcServer(configWith("http://127.0.0.1:8000"));
    expect(serverSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:8000",
      expect.objectContaining({ allowHttp: true }),
    );
  });

  it("sets allowHttp=false for a remote http:// URL", () => {
    // Config validation already blocks this at startup, but `createRpcServer`
    // must not open cleartext to a remote host if called by other means.
    serverSpy.mockClear();
    createRpcServer(configWith("http://soroban-testnet.stellar.org"));
    expect(serverSpy).toHaveBeenCalledWith(
      "http://soroban-testnet.stellar.org",
      expect.objectContaining({ allowHttp: false }),
    );
  });
});
