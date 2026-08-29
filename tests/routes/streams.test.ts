import Fastify from "fastify";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for stream route cache-control headers and ETag support.

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
  aggregateStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", () => streamsRepo);

// Valid strkeys used to exercise address normalization.
const ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const CONTRACT = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";

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

async function listRequest(url: string) {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url });
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
    const response = await listRequest("/streams");
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
  });

  it("trims and uppercases account address filters", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const padded = `  ${ACCOUNT.toLowerCase()} `;
    const response = await listRequest(`/streams?sender=${encodeURIComponent(padded)}`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ sender: ACCOUNT }),
    );
  });

  it("normalizes contract token address filters", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest(
      `/streams?token=${encodeURIComponent(CONTRACT.toLowerCase())}`,
    );
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ token: CONTRACT }),
    );
  });

  it("trims and uppercases token contract address filters", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const padded = `  ${CONTRACT.toLowerCase()} `;
    const response = await listRequest(`/streams?token=${encodeURIComponent(padded)}`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ token: CONTRACT }),
    );
  });

  it("rejects malformed token with standard client error", async () => {
    const response = await listRequest("/streams?token=not-an-address");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("code", "VALIDATION_ERROR");
    expect(response.json()).toHaveProperty("error", "invalid token address");
    expect(response.json()).toHaveProperty("requestId");
    expect(streamsRepo.listStreams).not.toHaveBeenCalled();
    expect(streamsRepo.countStreams).not.toHaveBeenCalled();
  });

  it("rejects address filters that cannot be normalized", async () => {
    const response = await listRequest("/streams?sender=not-an-address");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error", "invalid sender address");
    expect(streamsRepo.listStreams).not.toHaveBeenCalled();
  });
});

describe("GET /streams token filter", () => {
  it("omits token from filter when parameter is omitted", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest("/streams");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.not.objectContaining({ token: expect.anything() }),
    );
  });

  it("returns only matching streams for a token", async () => {
    const matches = [
      makeStream({ streamId: 1n, token: CONTRACT }),
      makeStream({ streamId: 2n, token: CONTRACT }),
    ];
    streamsRepo.listStreams.mockResolvedValue(matches);
    const response = await listRequest(`/streams?token=${CONTRACT}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.streams).toHaveLength(2);
    expect(body.streams.map((s: { id: string }) => s.id)).toEqual(["1", "2"]);
    expect(body).toHaveProperty("limit", 50);
    expect(body).toHaveProperty("offset", 0);
  });

  it("returns empty list for token with no streams", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest(`/streams?token=${CONTRACT}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.streams).toEqual([]);
  });

  it("applies token to the count query when includeTotal=true", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    streamsRepo.countStreams.mockResolvedValue(3);
    const response = await listRequest(`/streams?token=${CONTRACT}&includeTotal=true`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.countStreams).toHaveBeenCalledWith(
      expect.objectContaining({ token: CONTRACT }),
    );
    expect(response.json()).toHaveProperty("total", 3);
  });

  it("combines token with sender filter", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest(`/streams?sender=${ACCOUNT}&token=${CONTRACT}`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ sender: ACCOUNT, token: CONTRACT }),
    );
  });

  it("combines token with recipient filter", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest(`/streams?recipient=${ACCOUNT}&token=${CONTRACT}`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: ACCOUNT, token: CONTRACT }),
    );
  });

  it("combines token with cancelled filter", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    streamsRepo.countStreams.mockResolvedValue(1);
    const response = await listRequest(
      `/streams?token=${CONTRACT}&cancelled=true&includeTotal=true`,
    );
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ token: CONTRACT, cancelled: true }),
    );
    expect(streamsRepo.countStreams).toHaveBeenCalledWith(
      expect.objectContaining({ token: CONTRACT, cancelled: true }),
    );
  });

  it("works with pagination: limit and offset are applied alongside token", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest(`/streams?token=${CONTRACT}&limit=25&offset=50`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ token: CONTRACT, limit: 25, offset: 50 }),
    );
    const body = response.json();
    expect(body).toHaveProperty("limit", 25);
    expect(body).toHaveProperty("offset", 50);
  });

  it("honours the offset ceiling even when token is provided", async () => {
    const response = await listRequest(`/streams?token=${CONTRACT}&offset=10001`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("offset must not exceed 10000");
    expect(streamsRepo.listStreams).not.toHaveBeenCalled();
  });
});

describe("GET /streams offset ceiling", () => {
  it("returns 400 when the offset exceeds the ceiling", async () => {
    const response = await listRequest("/streams?offset=10001");
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toContain("offset must not exceed 10000");
    expect(streamsRepo.listStreams).not.toHaveBeenCalled();
  });

  it("accepts an offset equal to the ceiling", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest("/streams?offset=10000");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 10000 }),
    );
  });

  it("leaves small offsets unchanged", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest("/streams?limit=10&offset=20");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
  });
});

describe("GET /streams includeTotal", () => {
  it("omits total and skips the count query by default", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest("/streams");
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("total");
    expect(streamsRepo.countStreams).not.toHaveBeenCalled();
  });

  it("returns an accurate total when includeTotal=true", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    streamsRepo.countStreams.mockResolvedValue(7);
    const response = await listRequest("/streams?includeTotal=true");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ total: 7 }));
    expect(streamsRepo.countStreams).toHaveBeenCalledWith({});
  });
});

describe("GET /streams cancelled filter", () => {
  it("omits cancelled from filter when parameter is omitted", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest("/streams");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.not.objectContaining({ cancelled: expect.anything() }),
    );
  });

  it("filters cancelled streams when cancelled=true", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest("/streams?cancelled=true");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true }),
    );
  });

  it("filters active streams when cancelled=false", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    const response = await listRequest("/streams?cancelled=false");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: false }),
    );
  });

  it("applies cancelled=true to the count query when includeTotal=true", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    streamsRepo.countStreams.mockResolvedValue(3);
    const response = await listRequest("/streams?cancelled=true&includeTotal=true");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.countStreams).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true }),
    );
  });

  it("applies cancelled=false to the count query when includeTotal=true", async () => {
    streamsRepo.listStreams.mockResolvedValue([]);
    streamsRepo.countStreams.mockResolvedValue(5);
    const response = await listRequest("/streams?cancelled=false&includeTotal=true");
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.countStreams).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: false }),
    );
  });
});

describe("GET /streams/summary", () => {
  it("reports zeroed aggregates when there is no data", async () => {
    streamsRepo.aggregateStreams.mockResolvedValue({
      count: 0,
      totalAmount: "0",
      withdrawn: "0",
    });
    const response = await listRequest("/streams/summary");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
    expect(response.json()).toEqual({
      pending: { count: 0, totalAmount: "0", withdrawn: "0" },
      streaming: { count: 0, totalAmount: "0", withdrawn: "0" },
      completed: { count: 0, totalAmount: "0", withdrawn: "0" },
      cancelled: { count: 0, totalAmount: "0", withdrawn: "0" },
    });
  });

  it("groups mixed stream states with exact totals", async () => {
    // The route aggregates in pending, streaming, completed, cancelled order.
    streamsRepo.aggregateStreams
      .mockResolvedValueOnce({ count: 1, totalAmount: "100", withdrawn: "0" })
      .mockResolvedValueOnce({ count: 2, totalAmount: "340282366920938463464", withdrawn: "7" })
      .mockResolvedValueOnce({ count: 3, totalAmount: "99999999999999999999999999", withdrawn: "42" })
      .mockResolvedValueOnce({ count: 4, totalAmount: "12345", withdrawn: "12345" });
    const response = await listRequest("/streams/summary");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      pending: { count: 1, totalAmount: "100", withdrawn: "0" },
      streaming: { count: 2, totalAmount: "340282366920938463464", withdrawn: "7" },
      completed: { count: 3, totalAmount: "99999999999999999999999999", withdrawn: "42" },
      cancelled: { count: 4, totalAmount: "12345", withdrawn: "12345" },
    });
  });
});
