import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
}));

const indexedEventsRepo = vi.hoisted(() => ({
  listIndexedEvents: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", () => streamsRepo);
vi.mock("../../src/repositories/indexed-events.js", () => indexedEventsRepo);

const { streamRoutes } = await import("../../src/routes/streams.js");

beforeEach(() => {
  vi.resetAllMocks();
});

function makeStream() {
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
  };
}

async function getHistory(id: string) {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url: `/streams/${id}/events` });
  await app.close();
  return response;
}

describe("GET /streams/:id/events", () => {
  it("returns an empty array for a valid stream without events", async () => {
    streamsRepo.getStream.mockResolvedValue(makeStream());
    indexedEventsRepo.listIndexedEvents.mockResolvedValue([]);

    const response = await getHistory("42");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("returns events in eventId order and preserves decimal precision", async () => {
    streamsRepo.getStream.mockResolvedValue(makeStream());
    indexedEventsRepo.listIndexedEvents.mockResolvedValue([
      {
        eventId: "0000000000000000000001",
        kind: "created",
        streamId: "42",
        ledger: 100,
        txHash: "0xabc",
        sender: "GA1sender",
        recipient: "GB2recipient",
        token: "CA3token",
        totalAmount: { toString: () => "18446744073709551615" },
        amount: null,
        recipientAmount: null,
        senderRefund: null,
        startTime: 1n,
        endTime: 2n,
        cliffTime: 1n,
        closedAt: 100n,
      },
      {
        eventId: "0000000000000000000002",
        kind: "withdrawn",
        streamId: "42",
        ledger: 101,
        txHash: "0xdef",
        sender: null,
        recipient: "GB2recipient",
        token: null,
        totalAmount: null,
        amount: { toString: () => "1234567890123456789" },
        recipientAmount: null,
        senderRefund: null,
        startTime: null,
        endTime: null,
        cliffTime: null,
        closedAt: 101n,
      },
    ]);

    const response = await getHistory("42");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        eventId: "0000000000000000000001",
        kind: "created",
        totalAmount: "18446744073709551615",
      }),
      expect.objectContaining({
        eventId: "0000000000000000000002",
        kind: "withdrawn",
        amount: "1234567890123456789",
      }),
    ]);
  });

  it("returns 404 for an unknown stream", async () => {
    streamsRepo.getStream.mockResolvedValue(null);

    const response = await getHistory("999");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      error: "stream not found",
    });
  });
});
