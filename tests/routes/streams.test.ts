import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for stream route cache-control headers and ETag support.

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", () => streamsRepo);

const { streamRoutes } = await import("../../src/routes/streams.js");

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    streamId: BigInt(42),
    sender: "GA1sender",
    recipient: "GB2recipient",
    token: "CA3token",
    totalAmount: { toString: () => "1000000" },
    withdrawn: { toString: () => "0" },
    startTime: BigInt(1700000000),
    endTime: BigInt(1700003600),
    cliffTime: BigInt(1700000000),
    cancelled: false,
    createdLedger: 100,
    updatedLedger: 200,
    lastEventId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function getStreamById(id: string, headers: Record<string, string> = {}) {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({
    method: "GET",
    url: `/streams/${id}`,
    headers,
  });
  await app.close();
  return response;
}

async function listStreams() {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url: "/streams" });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /streams/:id", () => {
  it("returns cache-control header", async () => {
    streamsRepo.getStream.mockResolvedValue(makeStream());
    const response = await getStreamById("42");
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
  });

  it("returns ETag based on updatedLedger", async () => {
    streamsRepo.getStream.mockResolvedValue(makeStream({ updatedLedger: 200 }));
    const response = await getStreamById("42");
    expect(response.headers["etag"]).toBe('"200"');
  });

  it("returns 304 when If-None-Match matches", async () => {
    streamsRepo.getStream.mockResolvedValue(makeStream({ updatedLedger: 200 }));
    const response = await getStreamById("42", { "if-none-match": '"200"' });
    expect(response.statusCode).toBe(304);
  });

  it("returns full body when If-None-Match does not match", async () => {
    streamsRepo.getStream.mockResolvedValue(makeStream({ updatedLedger: 200 }));
    const response = await getStreamById("42", { "if-none-match": '"100"' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("id", "42");
  });

  it("returns full body with malformed If-None-Match header", async () => {
    streamsRepo.getStream.mockResolvedValue(makeStream({ updatedLedger: 200 }));
    const response = await getStreamById("42", { "if-none-match": "not-a-valid-etag" });
    expect(response.statusCode).toBe(200);
  });

  it("returns 404 for unknown stream", async () => {
    streamsRepo.getStream.mockResolvedValue(null);
    const response = await getStreamById("999");
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBeUndefined();
  });
});

describe("GET /streams", () => {
  it("returns cache-control header", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    streamsRepo.countStreams.mockResolvedValue(0);
    const response = await listStreams();
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
  });
});
