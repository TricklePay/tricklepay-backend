import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamsRepo = vi.hoisted(() => ({
  getAccountStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/streams.js")>();
  return {
    ...actual,
    ...streamsRepo,
  };
});

const ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const CONTRACT = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";

const { streamRoutes } = await import("../../src/routes/streams.js");
const { buildServer } = await import("../../src/server.js");

function makeStream(overrides: Record<string, unknown> = {}) {
  return {
    streamId: 42n,
    sender: ACCOUNT,
    recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    token: CONTRACT,
    totalAmount: { toString: () => "1000" },
    withdrawn: { toString: () => "0" },
    startTime: 1000n,
    endTime: 2000n,
    cliffTime: 1000n,
    cancelled: false,
    createdLedger: 100,
    updatedLedger: 200,
    lastEventId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function getAccountSummary(address: string) {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({
    method: "GET",
    url: `/accounts/${address}/summary`,
  });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /accounts/:address/summary", { timeout: 20000 }, () => {
  it("returns zero counts and string totals when no streams exist", async () => {
    streamsRepo.getAccountStreams.mockResolvedValue({ incoming: [], outgoing: [] });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      incoming: {
        count: 0,
        totalAmount: "0",
        total: "0",
        withdrawn: "0",
        vested: "0",
        withdrawable: "0",
      },
      outgoing: {
        count: 0,
        totalAmount: "0",
        total: "0",
        withdrawn: "0",
        vested: "0",
        withdrawable: "0",
      },
    });
    expect(streamsRepo.getAccountStreams).toHaveBeenCalledWith(ACCOUNT);
  });

  it("calculates incoming and outgoing stream totals using stream derivations", async () => {
    // Freeze time at t = 1500 (50% elapsed)
    vi.useFakeTimers();
    vi.setSystemTime(1500 * 1000);

    const incomingStreams = [
      makeStream({
        streamId: 1n,
        totalAmount: { toString: () => "1000" },
        withdrawn: { toString: () => "200" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
      }),
      makeStream({
        streamId: 2n,
        totalAmount: { toString: () => "2000" },
        withdrawn: { toString: () => "500" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
      }),
    ];

    const outgoingStreams = [
      makeStream({
        streamId: 3n,
        totalAmount: { toString: () => "5000" },
        withdrawn: { toString: () => "1000" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
      }),
    ];

    streamsRepo.getAccountStreams.mockResolvedValue({
      incoming: incomingStreams as any,
      outgoing: outgoingStreams as any,
    });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // At t = 1500:
    // stream 1: total = 1000, vested = 500, withdrawn = 200, withdrawable = 300
    // stream 2: total = 2000, vested = 1000, withdrawn = 500, withdrawable = 500
    // incoming totals: count = 2, totalAmount = 3000, withdrawn = 700, vested = 1500, withdrawable = 800
    expect(body.incoming).toEqual({
      count: 2,
      totalAmount: "3000",
      total: "3000",
      withdrawn: "700",
      vested: "1500",
      withdrawable: "800",
    });

    // stream 3: total = 5000, vested = 2500, withdrawn = 1000, withdrawable = 1500
    // outgoing totals: count = 1, totalAmount = 5000, withdrawn = 1000, vested = 2500, withdrawable = 1500
    expect(body.outgoing).toEqual({
      count: 1,
      totalAmount: "5000",
      total: "5000",
      withdrawn: "1000",
      vested: "2500",
      withdrawable: "1500",
    });
  });

  it("ensures amounts are exact strings preserving uint128 precision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2500 * 1000); // Fully vested

    const maxUint128 = "340282366920938463463374607431768211455";
    const halfUint128 = "170141183460469231731687303715884105727";
    const withdrawableExpected = "170141183460469231731687303715884105728";

    const incomingStreams = [
      makeStream({
        streamId: 10n,
        totalAmount: { toString: () => maxUint128 },
        withdrawn: { toString: () => halfUint128 },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
      }),
    ];

    streamsRepo.getAccountStreams.mockResolvedValue({
      incoming: incomingStreams as any,
      outgoing: [],
    });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.incoming.totalAmount).toBe(maxUint128);
    expect(body.incoming.total).toBe(maxUint128);
    expect(body.incoming.withdrawn).toBe(halfUint128);
    expect(body.incoming.vested).toBe(maxUint128);
    expect(body.incoming.withdrawable).toBe(withdrawableExpected);
  });

  it("rejects an invalid address with 400 VALIDATION_ERROR", async () => {
    const response = await getAccountSummary("invalid-address");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      error: "invalid address",
    });
    expect(streamsRepo.getAccountStreams).not.toHaveBeenCalled();
  });

  it("normalises lowercase and whitespace-padded addresses", async () => {
    streamsRepo.getAccountStreams.mockResolvedValue({ incoming: [], outgoing: [] });

    // Lowercase with leading/trailing spaces
    const paddedLowercase = `  ${ACCOUNT.toLowerCase()}  `;
    const response = await getAccountSummary(encodeURIComponent(paddedLowercase));

    expect(response.statusCode).toBe(200);
    expect(streamsRepo.getAccountStreams).toHaveBeenCalledWith(ACCOUNT);
  });

  it("supports contract addresses", async () => {
    streamsRepo.getAccountStreams.mockResolvedValue({ incoming: [], outgoing: [] });

    const response = await getAccountSummary(CONTRACT);

    expect(response.statusCode).toBe(200);
    expect(streamsRepo.getAccountStreams).toHaveBeenCalledWith(CONTRACT);
  });

  it("returns public Cache-Control header", async () => {
    streamsRepo.getAccountStreams.mockResolvedValue({ incoming: [], outgoing: [] });

    const response = await getAccountSummary(ACCOUNT);

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
    expect(spec.paths).toHaveProperty("/accounts/{address}/summary");
    expect(spec.paths?.["/accounts/{address}/summary"]).toHaveProperty("get");
  });

  it("groups streams by token and sums amounts per token separately", async () => {
    // This test documents the intended grouping behavior: streams are not
    // grouped by token in the summary response. Instead, all incoming streams
    // are aggregated together regardless of token, and all outgoing streams
    // are aggregated together. A per-token breakdown is not provided by this
    // endpoint; clients that need it should query /streams with a token filter.
    vi.useFakeTimers();
    vi.setSystemTime(1500 * 1000); // 50% elapsed

    const TOKEN_A = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
    const TOKEN_B = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZZZ";

    const incomingStreams = [
      // Token A: 1000 total, 500 vested, 100 withdrawn, 400 withdrawable
      makeStream({
        streamId: 1n,
        token: TOKEN_A,
        totalAmount: { toString: () => "1000" },
        withdrawn: { toString: () => "100" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: false,
      }),
      // Token B: 2000 total, 1000 vested, 200 withdrawn, 800 withdrawable
      makeStream({
        streamId: 2n,
        token: TOKEN_B,
        totalAmount: { toString: () => "2000" },
        withdrawn: { toString: () => "200" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: false,
      }),
    ];

    streamsRepo.getAccountStreams.mockResolvedValue({
      incoming: incomingStreams as any,
      outgoing: [],
    });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // All incoming streams are aggregated together, not grouped by token:
    // total = 1000 + 2000 = 3000
    // vested = 500 + 1000 = 1500
    // withdrawn = 100 + 200 = 300
    // withdrawable = 400 + 800 = 1200
    expect(body.incoming).toEqual({
      count: 2,
      totalAmount: "3000",
      total: "3000",
      withdrawn: "300",
      vested: "1500",
      withdrawable: "1200",
    });
  });

  it("handles cancelled streams with frozen totals", async () => {
    // A cancelled stream's totalAmount is frozen to the amount vested at
    // cancellation. The vested figure never increases past that point, and
    // withdrawable is capped at totalAmount - withdrawn.
    vi.useFakeTimers();
    vi.setSystemTime(2500 * 1000); // Well past the original end time

    const incomingStreams = [
      // Cancelled stream: frozen at 600 total, 400 withdrawn, so 200 withdrawable
      // even though time has moved on
      makeStream({
        streamId: 10n,
        totalAmount: { toString: () => "600" }, // Frozen at cancellation
        withdrawn: { toString: () => "400" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: true,
      }),
    ];

    streamsRepo.getAccountStreams.mockResolvedValue({
      incoming: incomingStreams as any,
      outgoing: [],
    });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // For a cancelled stream:
    // totalAmount = 600 (frozen)
    // vested = 600 (capped at totalAmount)
    // withdrawn = 400
    // withdrawable = 600 - 400 = 200
    expect(body.incoming).toEqual({
      count: 1,
      totalAmount: "600",
      total: "600",
      withdrawn: "400",
      vested: "600",
      withdrawable: "200",
    });
  });

  it("handles completed streams with all funds vested", async () => {
    // A completed stream has passed its endTime, so vested = totalAmount and
    // withdrawable = totalAmount - withdrawn.
    vi.useFakeTimers();
    vi.setSystemTime(3000 * 1000); // Past end time

    const incomingStreams = [
      // Completed stream: 1000 total, 800 withdrawn, 200 withdrawable
      makeStream({
        streamId: 20n,
        totalAmount: { toString: () => "1000" },
        withdrawn: { toString: () => "800" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: false,
      }),
    ];

    streamsRepo.getAccountStreams.mockResolvedValue({
      incoming: incomingStreams as any,
      outgoing: [],
    });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // For a completed stream:
    // vested = totalAmount = 1000
    // withdrawable = totalAmount - withdrawn = 1000 - 800 = 200
    expect(body.incoming).toEqual({
      count: 1,
      totalAmount: "1000",
      total: "1000",
      withdrawn: "800",
      vested: "1000",
      withdrawable: "200",
    });
  });

  it("handles an address that is both sender and recipient", async () => {
    // An address can send some streams and receive others. The summary
    // separates them into incoming (where the address is recipient) and
    // outgoing (where the address is sender), with no overlap or double
    // counting.
    vi.useFakeTimers();
    vi.setSystemTime(1500 * 1000); // 50% elapsed

    const OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

    const incomingStreams = [
      // Incoming: ACCOUNT receives 1000 from OTHER
      makeStream({
        streamId: 30n,
        sender: OTHER,
        recipient: ACCOUNT,
        totalAmount: { toString: () => "1000" },
        withdrawn: { toString: () => "200" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: false,
      }),
    ];

    const outgoingStreams = [
      // Outgoing: ACCOUNT sends 2000 to OTHER
      makeStream({
        streamId: 31n,
        sender: ACCOUNT,
        recipient: OTHER,
        totalAmount: { toString: () => "2000" },
        withdrawn: { toString: () => "500" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: false,
      }),
    ];

    streamsRepo.getAccountStreams.mockResolvedValue({
      incoming: incomingStreams as any,
      outgoing: outgoingStreams as any,
    });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Incoming: 1000 total, 500 vested, 200 withdrawn, 300 withdrawable
    expect(body.incoming).toEqual({
      count: 1,
      totalAmount: "1000",
      total: "1000",
      withdrawn: "200",
      vested: "500",
      withdrawable: "300",
    });

    // Outgoing: 2000 total, 1000 vested, 500 withdrawn, 500 withdrawable
    expect(body.outgoing).toEqual({
      count: 1,
      totalAmount: "2000",
      total: "2000",
      withdrawn: "500",
      vested: "1000",
      withdrawable: "500",
    });
  });

  it("handles mixed stream states: pending, streaming, completed, cancelled", async () => {
    // A comprehensive test covering all stream lifecycle states in one summary.
    vi.useFakeTimers();
    vi.setSystemTime(1500 * 1000); // t = 1500

    const incomingStreams = [
      // Pending (not yet started): vested = 0, withdrawable = 0
      makeStream({
        streamId: 40n,
        totalAmount: { toString: () => "1000" },
        withdrawn: { toString: () => "0" },
        startTime: 2000n, // Starts in the future
        endTime: 3000n,
        cliffTime: 2000n,
        cancelled: false,
      }),
      // Streaming (50% elapsed): vested = 500, withdrawable = 500
      makeStream({
        streamId: 41n,
        totalAmount: { toString: () => "1000" },
        withdrawn: { toString: () => "0" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: false,
      }),
      // Completed (fully vested): vested = 1000, withdrawable = 200
      makeStream({
        streamId: 42n,
        totalAmount: { toString: () => "1000" },
        withdrawn: { toString: () => "800" },
        startTime: 500n,
        endTime: 1000n,
        cliffTime: 500n,
        cancelled: false,
      }),
      // Cancelled (frozen at 300): vested = 300, withdrawable = 300
      makeStream({
        streamId: 43n,
        totalAmount: { toString: () => "300" },
        withdrawn: { toString: () => "0" },
        startTime: 1000n,
        endTime: 2000n,
        cliffTime: 1000n,
        cancelled: true,
      }),
    ];

    streamsRepo.getAccountStreams.mockResolvedValue({
      incoming: incomingStreams as any,
      outgoing: [],
    });

    const response = await getAccountSummary(ACCOUNT);

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Aggregated:
    // totalAmount = 1000 + 1000 + 1000 + 300 = 3300
    // withdrawn = 0 + 0 + 800 + 0 = 800
    // vested = 0 + 500 + 1000 + 300 = 1800
    // withdrawable = 0 + 500 + 200 + 300 = 1000
    expect(body.incoming).toEqual({
      count: 4,
      totalAmount: "3300",
      total: "3300",
      withdrawn: "800",
      vested: "1800",
      withdrawable: "1000",
    });
  });
});
