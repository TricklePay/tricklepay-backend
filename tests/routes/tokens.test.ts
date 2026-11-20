import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamsRepo = vi.hoisted(() => ({
  listTokens: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/streams.js")>();
  return {
    ...actual,
    ...streamsRepo,
  };
});

const { streamRoutes } = await import("../../src/routes/streams.js");
const { buildServer } = await import("../../src/server.js");

async function getTokens() {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url: "/tokens" });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /tokens", { timeout: 20000 }, () => {
  it("returns an empty array when no streams exist", async () => {
    streamsRepo.listTokens.mockResolvedValue([]);
    const response = await getTokens();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual([]);
  });

  it("returns each distinct token with its count and total", async () => {
    const mockData = [
      {
        token: "CA111111111111111111111111111111111111111111111111111111",
        count: 5,
        total: "5000000000",
      },
      {
        token: "CB222222222222222222222222222222222222222222222222222222",
        count: 2,
        total: "1234567890",
      },
    ];
    streamsRepo.listTokens.mockResolvedValue(mockData);

    const response = await getTokens();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(mockData);
  });

  it("ensures amounts are exact strings preserving uint128 precision", async () => {
    const maxUint128 = "340282366920938463463374607431768211455";
    const largeAmount = "18446744073709551616";
    const mockData = [
      {
        token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
        count: 1,
        total: maxUint128,
      },
      {
        token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        count: 10,
        total: largeAmount,
      },
    ];
    streamsRepo.listTokens.mockResolvedValue(mockData);

    const response = await getTokens();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(typeof body[0].total).toBe("string");
    expect(body[0].total).toBe(maxUint128);
    expect(typeof body[1].total).toBe("string");
    expect(body[1].total).toBe(largeAmount);
  });

  it("returns public cache-control header", async () => {
    streamsRepo.listTokens.mockResolvedValue([]);
    const response = await getTokens();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
  });

  it("appears in the OpenAPI document", async () => {
    const app = await buildServer();
    await app.register(streamRoutes);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/docs/json" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const spec = response.json() as { paths?: Record<string, { get?: unknown }> };
    expect(spec.paths).toHaveProperty("/tokens");
    expect(spec.paths?.["/tokens"]).toHaveProperty("get");
  });
});
