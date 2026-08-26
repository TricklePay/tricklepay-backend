import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #65 — API tests for large uint128 values.
//
// The API promises string serialization for amounts larger than JavaScript's
// safe integer range. These tests verify that stored and derived fields remain
// exact decimal strings at and near the uint128 boundary.

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", () => streamsRepo);

const { streamRoutes } = await import("../../src/routes/streams.js");

// uint128 max: 2^128 - 1
const UINT128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n;
// A value just below to test near-boundary behavior.
const NEAR_UINT128_MAX = UINT128_MAX - 1n;

function makeLargeStream(overrides: Record<string, unknown> = {}) {
  const total = overrides.totalAmount ?? UINT128_MAX;
  const withdrawn = overrides.withdrawn ?? 0n;
  return {
    streamId: BigInt(42),
    sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
    totalAmount: { toString: () => total.toString() },
    withdrawn: { toString: () => withdrawn.toString() },
    startTime: BigInt(1700000000),
    endTime: BigInt(1800000000),
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

async function getStreamById(id: string) {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url: `/streams/${id}` });
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

describe("large uint128 values (#65)", () => {
  describe("GET /streams/:id with uint128 max total", () => {
    it("returns totalAmount as a decimal string, not a number", async () => {
      streamsRepo.getStream.mockResolvedValue(makeLargeStream());
      const res = await getStreamById("42");
      const body = res.json();

      expect(typeof body.totalAmount).toBe("string");
      expect(body.totalAmount).toBe(UINT128_MAX.toString());
    });

    it("returns withdrawn as a decimal string", async () => {
      streamsRepo.getStream.mockResolvedValue(
        makeLargeStream({ withdrawn: NEAR_UINT128_MAX }),
      );
      const res = await getStreamById("42");
      const body = res.json();

      expect(typeof body.withdrawn).toBe("string");
      expect(body.withdrawn).toBe(NEAR_UINT128_MAX.toString());
    });

    it("returns vested as a decimal string at boundary", async () => {
      // startTime = endTime means the stream is completed, vested = total.
      streamsRepo.getStream.mockResolvedValue(
        makeLargeStream({
          startTime: BigInt(1700000000),
          endTime: BigInt(1700000000), // zero-length → completed immediately
        }),
      );
      const res = await getStreamById("42");
      const body = res.json();

      expect(typeof body.vested).toBe("string");
      expect(body.vested).toBe(UINT128_MAX.toString());
    });

    it("returns withdrawable as a decimal string", async () => {
      streamsRepo.getStream.mockResolvedValue(makeLargeStream());
      const res = await getStreamById("42");
      const body = res.json();

      expect(typeof body.withdrawable).toBe("string");
      // No withdrawals, so withdrawable == vested. At end time, vested == total.
      // But the route uses Date.now() for `now`, so vested may not equal total.
      // Just verify it's a string.
      expect(body.withdrawable).toMatch(/^\d+$/);
    });

    it("returns locked as a decimal string", async () => {
      streamsRepo.getStream.mockResolvedValue(makeLargeStream());
      const res = await getStreamById("42");
      const body = res.json();

      expect(typeof body.locked).toBe("string");
      expect(body.locked).toMatch(/^\d+$/);
    });

    it("fails if any amount field is serialized as a JavaScript number", async () => {
      streamsRepo.getStream.mockResolvedValue(makeLargeStream());
      const res = await getStreamById("42");
      const body = res.json();

      const amountFields = ["totalAmount", "withdrawn", "vested", "withdrawable", "locked"];
      for (const field of amountFields) {
        expect(typeof body[field]).not.toBe("number");
      }
    });
  });

  describe("GET /streams with large values", () => {
    it("returns large amounts as strings in the list endpoint", async () => {
      streamsRepo.listStreams.mockResolvedValue([
        makeLargeStream({ streamId: BigInt(1) }),
        makeLargeStream({ streamId: BigInt(2), withdrawn: 1n }),
      ]);
      streamsRepo.countStreams.mockResolvedValue(2);

      const res = await listStreams();
      const body = res.json();

      expect(body.streams).toHaveLength(2);
      for (const s of body.streams) {
        expect(typeof s.totalAmount).toBe("string");
        expect(typeof s.withdrawn).toBe("string");
        expect(typeof s.vested).toBe("string");
        expect(typeof s.withdrawable).toBe("string");
        expect(typeof s.locked).toBe("string");
      }
    });
  });

  describe("near-uint128 boundary arithmetic", () => {
    it("vested and withdrawable stay exact when total is near uint128 max", async () => {
      // Use a stream that's completed (endTime in the past) so vested == total.
      const pastEnd = BigInt(Math.floor(Date.now() / 1000)) - 1000n;
      streamsRepo.getStream.mockResolvedValue(
        makeLargeStream({
          startTime: pastEnd - 1000n,
          endTime: pastEnd,
          cliffTime: pastEnd - 1000n,
        }),
      );
      const res = await getStreamById("42");
      const body = res.json();

      expect(body.vested).toBe(UINT128_MAX.toString());
      expect(body.withdrawable).toBe(UINT128_MAX.toString());
      expect(body.locked).toBe("0");
    });
  });
});
