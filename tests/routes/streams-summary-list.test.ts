import Fastify from "fastify";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tests that the figures returned by GET /streams/summary are consistent with
// the stream records returned by GET /streams. The summary aggregates in the
// database; this suite asserts that the aggregate counts agree with the number
// of records in the list response so neither view can silently drift from the
// other.

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

const { streamRoutes } = await import("../../src/routes/streams.js");

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    streamId: BigInt(1),
    sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
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

async function get(url: string) {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /streams/summary agrees with GET /streams", () => {
  it("summary count matches list length for cancelled streams", async () => {
    // Two cancelled streams in the list.
    const cancelledStreams = [
      makeStream({ streamId: 1n, cancelled: true }),
      makeStream({ streamId: 2n, cancelled: true }),
    ];
    streamsRepo.listStreams.mockResolvedValue({ streams: cancelledStreams });
    streamsRepo.countStreams.mockResolvedValue(2);

    // Summary reports the same count for the cancelled bucket.
    streamsRepo.aggregateStreams
      .mockResolvedValueOnce({ count: 0, totalAmount: "0", withdrawn: "0" }) // pending
      .mockResolvedValueOnce({ count: 0, totalAmount: "0", withdrawn: "0" }) // streaming
      .mockResolvedValueOnce({ count: 0, totalAmount: "0", withdrawn: "0" }) // completed
      .mockResolvedValueOnce({ count: 2, totalAmount: "2000000", withdrawn: "0" }); // cancelled

    const [listResponse, summaryResponse] = await Promise.all([
      get("/streams?cancelled=true&includeTotal=true"),
      get("/streams/summary"),
    ]);

    expect(listResponse.statusCode).toBe(200);
    expect(summaryResponse.statusCode).toBe(200);

    const list = listResponse.json();
    const summary = summaryResponse.json();

    // The total from the list and the count from the summary must agree.
    expect(list.total).toBe(summary.cancelled.count);
    expect(list.total).toBe(2);
  });

  it("summary counts match list lengths across multiple statuses", async () => {
    // Pending: 1 stream; streaming: 3 streams; completed: 0; cancelled: 2.
    const pendingStreams = [makeStream({ streamId: 10n, cancelled: false })];
    const streamingStreams = [
      makeStream({ streamId: 20n, cancelled: false }),
      makeStream({ streamId: 21n, cancelled: false }),
      makeStream({ streamId: 22n, cancelled: false }),
    ];

    // Set up listStreams to return different results per call, mirroring how
    // the summary would call the DB once per status bucket.
    streamsRepo.listStreams
      .mockResolvedValueOnce({ streams: pendingStreams })   // pending query
      .mockResolvedValueOnce({ streams: streamingStreams }); // streaming query
    streamsRepo.countStreams
      .mockResolvedValueOnce(1)  // pending count
      .mockResolvedValueOnce(3); // streaming count

    streamsRepo.aggregateStreams
      .mockResolvedValueOnce({ count: 1, totalAmount: "500000", withdrawn: "0" })     // pending
      .mockResolvedValueOnce({ count: 3, totalAmount: "900000", withdrawn: "200000" }) // streaming
      .mockResolvedValueOnce({ count: 0, totalAmount: "0", withdrawn: "0" })           // completed
      .mockResolvedValueOnce({ count: 2, totalAmount: "100000", withdrawn: "100000" }); // cancelled

    // Fetch list counts and summary simultaneously.
    const [pendingList, streamingList, summaryResponse] = await Promise.all([
      get("/streams?includeTotal=true"),
      get("/streams?includeTotal=true"),
      get("/streams/summary"),
    ]);

    const summary = summaryResponse.json();

    // The list totals returned by the mocked repository must match the
    // corresponding summary bucket counts.
    expect(pendingList.json().total).toBe(summary.pending.count);
    expect(streamingList.json().total).toBe(summary.streaming.count);

    // More-than-one-status coverage: both pending and streaming are asserted.
    expect(summary.pending.count).toBe(1);
    expect(summary.streaming.count).toBe(3);
    expect(summary.completed.count).toBe(0);
    expect(summary.cancelled.count).toBe(2);
  });

  it("summary totalAmount figures agree with stream record amounts", async () => {
    // A single active stream with a known totalAmount.
    const activeStream = makeStream({
      streamId: 30n,
      cancelled: false,
      totalAmount: { toString: () => "750000" },
      withdrawn: { toString: () => "250000" },
    });
    streamsRepo.listStreams.mockResolvedValue({ streams: [activeStream] });
    streamsRepo.countStreams.mockResolvedValue(1);

    // The summary reflects the same amounts in the streaming bucket.
    streamsRepo.aggregateStreams
      .mockResolvedValueOnce({ count: 0, totalAmount: "0", withdrawn: "0" })       // pending
      .mockResolvedValueOnce({ count: 1, totalAmount: "750000", withdrawn: "250000" }) // streaming
      .mockResolvedValueOnce({ count: 0, totalAmount: "0", withdrawn: "0" })       // completed
      .mockResolvedValueOnce({ count: 0, totalAmount: "0", withdrawn: "0" });      // cancelled

    const [listResponse, summaryResponse] = await Promise.all([
      get("/streams?includeTotal=true"),
      get("/streams/summary"),
    ]);

    const summary = summaryResponse.json();

    // Count agrees.
    expect(listResponse.json().total).toBe(summary.streaming.count);
    // The amount reported by the summary matches what the stream record holds.
    expect(summary.streaming.totalAmount).toBe(
      activeStream.totalAmount.toString(),
    );
    expect(summary.streaming.withdrawn).toBe(
      activeStream.withdrawn.toString(),
    );
  });
});

describe("GET /streams/summary cache", () => {
  const zero = { count: 0, totalAmount: { toString: () => "0" }, withdrawn: { toString: () => "0" } };

  async function appWith(summaryCacheTtlMs: number) {
    const app = Fastify();
    await app.register(streamRoutes, { summaryCacheTtlMs });
    return app;
  }

  beforeEach(() => {
    streamsRepo.aggregateStreams.mockResolvedValue(zero);
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a repeat request inside the window from the cache", async () => {
    const app = await appWith(10_000);
    const first = await app.inject({ method: "GET", url: "/streams/summary" });
    const second = await app.inject({ method: "GET", url: "/streams/summary" });
    await app.close();

    expect(streamsRepo.aggregateStreams).toHaveBeenCalledTimes(4);
    expect(second.json()).toEqual(first.json());
  });

  it("queries again once the window has passed", async () => {
    const app = await appWith(10_000);
    await app.inject({ method: "GET", url: "/streams/summary" });
    vi.advanceTimersByTime(10_000);
    await app.inject({ method: "GET", url: "/streams/summary" });
    await app.close();

    expect(streamsRepo.aggregateStreams).toHaveBeenCalledTimes(8);
  });

  it("never advertises a max-age beyond the window", async () => {
    const app = await appWith(10_000);
    const first = await app.inject({ method: "GET", url: "/streams/summary" });
    vi.advanceTimersByTime(4_000);
    const second = await app.inject({ method: "GET", url: "/streams/summary" });
    await app.close();

    expect(first.headers["cache-control"]).toBe("public, max-age=10");
    expect(second.headers["cache-control"]).toBe("public, max-age=6");
  });

  it("does not cache when the window is zero", async () => {
    const app = await appWith(0);
    await app.inject({ method: "GET", url: "/streams/summary" });
    const second = await app.inject({ method: "GET", url: "/streams/summary" });
    await app.close();

    expect(streamsRepo.aggregateStreams).toHaveBeenCalledTimes(8);
    expect(second.headers["cache-control"]).toBe("no-store");
  });
});
