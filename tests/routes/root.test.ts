import Fastify from "fastify";
import { describe, expect, it } from "vitest";

// Root endpoint returns the configured Stellar network name so clients can
// catch testnet/mainnet wiring mistakes without reading private configuration.

const { rootRoutes } = await import("../../src/routes/root.js");

const mockConfig = {
  network: "testnet",
  port: 3000,
  host: "0.0.0.0",
  databaseUrl: "postgres://test",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CA123",
  pollIntervalMs: 5000,
  startLedger: 0,
  bodyLimit: 1048576,
  queryStringLimit: 2048,
};

async function getRoot() {
  const app = Fastify();
  await app.register(rootRoutes(mockConfig));
  const response = await app.inject({ method: "GET", url: "/" });
  await app.close();
  return { statusCode: response.statusCode, body: response.json() };
}

describe("GET /", () => {
  it("includes the network name in the response", async () => {
    const { statusCode, body } = await getRoot();
    expect(statusCode).toBe(200);
    expect(body).toHaveProperty("network");
    expect(typeof body.network).toBe("string");
    expect(["testnet", "mainnet"]).toContain(body.network);
  });

  it("still returns the standard API index fields", async () => {
    const { body } = await getRoot();
    expect(body).toHaveProperty("name", "tricklepay-backend");
    expect(body).toHaveProperty("description");
    expect(body).toHaveProperty("endpoints");
    expect(Array.isArray(body.endpoints)).toBe(true);
  });
});
