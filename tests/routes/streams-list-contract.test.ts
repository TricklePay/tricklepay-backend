import { beforeEach, describe, expect, it, vi } from "vitest";

// Contract tests for GET /streams: unknown query parameters, the cursor/offset
// interaction, and the includeTotal opt-in. They run against a seeded set of
// streams served by a mocked repository, so no database or listening server is
// needed.

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
  aggregateStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/streams.js")>();
  return {
    ...actual,
    ...streamsRepo,
  };
});

const { encodeCursor } = await import("../../src/repositories/streams.js");
const { streamRoutes } = await import("../../src/routes/streams.js");
const { buildServer } = await import("../../src/server.js");

function makeStream(streamId: bigint) {
  return {
    streamId,
    sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
    totalAmount: { toString: () => "1000000" },
    withdrawn: { toString: () => "0" },
    startTime: 1700000000n,
    endTime: 1700003600n,
    cliffTime: 1700000000n,
    cancelled: false,
    createdLedger: 100,
    updatedLedger: 200,
    lastEventId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Streams are listed newest first.
const SEEDED = [5n, 4n, 3n, 2n, 1n].map(makeStream);

async function get(url: string) {
  // buildServer carries the production validator and error handlers.
  const app = await buildServer();
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
  streamsRepo.listStreams.mockResolvedValue({ streams: SEEDED });
  streamsRepo.countStreams.mockResolvedValue(SEEDED.length);
});

describe("GET /streams ids filter", () => {
  it("passes parsed, deduplicated ids to list and count queries", async () => {
    streamsRepo.listStreams.mockResolvedValue({ streams: [SEEDED[2], SEEDED[4]] });
    streamsRepo.countStreams.mockResolvedValue(2);
    const response = await get("/streams?ids=1,3,1,999&includeTotal=true");
    expect(response.statusCode).toBe(200);
    expect(response.json().streams.map((stream: { id: string }) => stream.id)).toEqual(["3", "1"]);
    expect(response.json().total).toBe(2);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(expect.objectContaining({ ids: [1n, 3n, 999n] }));
    expect(streamsRepo.countStreams).toHaveBeenCalledWith(expect.objectContaining({ ids: [1n, 3n, 999n] }));
  });

  it.each(["", ",", "1,", ",1", "1,,2", "-1", "1.5", "abc", "1e3", "18446744073709551616"])(
    "rejects invalid ids %j before querying",
    async (ids) => {
      const response = await get(`/streams?ids=${encodeURIComponent(ids)}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("VALIDATION_ERROR");
      expect(streamsRepo.listStreams).not.toHaveBeenCalled();
      expect(streamsRepo.countStreams).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly 100 ids", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => index + 1).join(",");
    const response = await get(`/streams?ids=${ids}&limit=100`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams.mock.calls[0][0].ids).toHaveLength(100);
  });

  it("rejects more than 100 entries even when they are duplicates", async () => {
    const response = await get(`/streams?ids=${Array(101).fill("1").join(",")}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("at most 100");
    expect(streamsRepo.listStreams).not.toHaveBeenCalled();
  });

  it("combines ids with existing filters and pagination", async () => {
    const cursor = encodeCursor(5n);
    const response = await get(`/streams?ids=1,2&cancelled=false&limit=1&cursor=${cursor}`);
    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(expect.objectContaining({
      ids: [1n, 2n], cancelled: false, limit: 1, cursor: 5n,
    }));
  });

  it("passes ids and lifecycle status to list and count with the same timestamp", async () => {
    const response = await get("/streams?ids=1,3&status=streaming&includeTotal=true");
    expect(response.statusCode).toBe(200);
    const now = streamsRepo.listStreams.mock.calls[0][1];
    expect(typeof now).toBe("bigint");
    const filter = expect.objectContaining({ ids: [1n, 3n], status: "streaming" });
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(filter, now);
    expect(streamsRepo.countStreams).toHaveBeenCalledWith(filter, now);
  });
});

describe("GET /streams unknown query parameters", () => {
  it("rejects a misspelt parameter with a 400", async () => {
    const response = await get("/streams?limt=5");
    expect(response.statusCode).toBe(400);
    expect(streamsRepo.listStreams).not.toHaveBeenCalled();
  });

  it("returns the documented error shape and code", async () => {
    const response = await get("/streams?limt=5");
    const body = response.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("must NOT have additional properties");
    expect(typeof body.requestId).toBe("string");
  });

  it("still succeeds for a valid request", async () => {
    const response = await get("/streams?limit=5");
    expect(response.statusCode).toBe(200);
    expect(response.json().streams).toHaveLength(SEEDED.length);
    expect(response.json().limit).toBe(5);
  });
});

describe("GET /streams cursor and offset", () => {
  it("reports offset 0 and ignores the offset when a cursor is supplied", async () => {
    const cursor = encodeCursor(6n);
    const response = await get(`/streams?cursor=${encodeURIComponent(cursor)}&offset=3`);
    expect(response.statusCode).toBe(200);
    expect(response.json().offset).toBe(0);
    expect(response.json().streams).toHaveLength(SEEDED.length);
  });

  it("reports the requested offset when no cursor is supplied", async () => {
    const response = await get("/streams?offset=3");
    expect(response.statusCode).toBe(200);
    expect(response.json().offset).toBe(3);
  });

  it("skips the offset ceiling when a cursor is supplied", async () => {
    const cursor = encodeCursor(6n);
    const response = await get(`/streams?cursor=${encodeURIComponent(cursor)}&offset=10001`);
    expect(response.statusCode).toBe(200);
    expect(response.json().offset).toBe(0);
    expect(streamsRepo.listStreams).toHaveBeenCalled();
  });

  it("still enforces the offset ceiling without a cursor", async () => {
    const response = await get("/streams?offset=10001");
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /streams includeTotal", () => {
  it("omits total by default and does not run the count query", async () => {
    const response = await get("/streams");
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("total");
    expect(streamsRepo.countStreams).not.toHaveBeenCalled();
  });

  it("omits total and skips the count when includeTotal=false", async () => {
    const response = await get("/streams?includeTotal=false");
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("total");
    expect(streamsRepo.countStreams).not.toHaveBeenCalled();
  });

  it("returns the correct total when includeTotal=true", async () => {
    const response = await get("/streams?includeTotal=true");
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(SEEDED.length);
    expect(streamsRepo.countStreams).toHaveBeenCalledTimes(1);
  });
});
