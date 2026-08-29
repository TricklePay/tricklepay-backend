import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type Stream } from "@prisma/client";

import { prisma } from "../../src/db.js";
import {
  clearFailedEvent,
  failedEventFromDecoded,
  recordFailedEvent,
} from "../../src/repositories/failed-events.js";
import {
  countStreams,
  listStreams,
  type StreamFilter,
} from "../../src/repositories/streams.js";

type StreamRow = Stream & {
  totalAmount: Prisma.Decimal;
  withdrawn: Prisma.Decimal;
};

function partialStream(overrides: Partial<StreamRow> = {}): StreamRow {
  return {
    streamId: 1n,
    sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
    totalAmount: new Prisma.Decimal(0),
    withdrawn: new Prisma.Decimal(0),
    startTime: 0n,
    endTime: 0n,
    cliffTime: 0n,
    cancelled: false,
    createdLedger: 0,
    updatedLedger: 0,
    lastEventId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as StreamRow;
}

describe("failed events repository", () => {
  it("records the diagnostic details needed for an operator to find a failed event", async () => {
    const upsert = vi.spyOn(prisma.failedEvent, "upsert").mockResolvedValueOnce({} as never);

    await recordFailedEvent({
      eventId: "0000000000000000001",
      kind: "created",
      streamId: "7",
      ledger: 123,
      error: "stream missing",
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { eventId: "0000000000000000001" },
      create: {
        eventId: "0000000000000000001",
        kind: "created",
        streamId: "7",
        ledger: 123,
        error: "stream missing",
        failureCount: 1,
      },
      update: {
        error: "stream missing",
        failureCount: { increment: 1 },
      },
    });
  });

  it("clears the failed-event record after a successful apply", async () => {
    const deleteMany = vi.spyOn(prisma.failedEvent, "deleteMany").mockResolvedValueOnce({ count: 1 });

    await clearFailedEvent("0000000000000000001");

    expect(deleteMany).toHaveBeenCalledWith({ where: { eventId: "0000000000000000001" } });
  });

  it("builds a failed-event summary from a decoded event and error", () => {
    const event = {
      id: "0000000000000000002",
      kind: "withdrawn",
      streamId: 99n,
      ledger: 321,
      closedAt: 123n,
      txHash: "0xabc",
      recipient: "Grecipient",
      amount: 50n,
    } as any;

    expect(failedEventFromDecoded(event, new Error("insufficient balance"))).toEqual({
      eventId: "0000000000000000002",
      kind: "withdrawn",
      streamId: "99",
      ledger: 321,
      error: "insufficient balance",
    });
  });
});

describe("streams repository token filter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("listStreams with no filter does not constrain token in where clause", async () => {
    const rows = [partialStream()];
    const spy = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce(rows);
    const filter: StreamFilter = {};
    const result = await listStreams(filter);
    expect(result).toBe(rows);
    expect(spy).toHaveBeenCalledOnce();
    const args = spy.mock.calls[0][0]!;
    expect((args.where as Record<string, unknown> | undefined)?.token).toBeUndefined();
  });

  it("listStreams with token filter passes exact token to where clause", async () => {
    const token = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
    const rows = [partialStream({ token })];
    const spy = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce(rows);
    const result = await listStreams({ token });
    expect(result).toBe(rows);
    const where = spy.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.token).toBe(token);
  });

  it("listStreams returns empty array when no streams match token", async () => {
    const spy = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    const result = await listStreams({
      token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
    });
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("listStreams combines token with sender and cancelled filters", async () => {
    const token = "CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const sender = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const spy = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    await listStreams({ token, sender, cancelled: false });
    const where = spy.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.token).toBe(token);
    expect(where.sender).toBe(sender);
    expect(where.cancelled).toBe(false);
  });

  it("listStreams combines token with recipient filter", async () => {
    const token = "CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const recipient = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    const spy = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    await listStreams({ token, recipient });
    const where = spy.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.token).toBe(token);
    expect(where.recipient).toBe(recipient);
  });

  it("listStreams preserves limit and offset alongside token filter", async () => {
    const spy = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    const token = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
    await listStreams({ token, limit: 10, offset: 30 });
    const args = spy.mock.calls[0][0]!;
    expect((args.where as Record<string, unknown>).token).toBe(token);
    expect(args.take).toBe(10);
    expect(args.skip).toBe(30);
  });

  it("countStreams with no filter does not constrain token", async () => {
    const spy = vi.spyOn(prisma.stream, "count").mockResolvedValueOnce(7);
    const filter: StreamFilter = {};
    const result = await countStreams(filter);
    expect(result).toBe(7);
    const args = spy.mock.calls[0][0]!;
    expect((args.where as Record<string, unknown> | undefined)?.token).toBeUndefined();
  });

  it("countStreams applies token filter to the count where clause", async () => {
    const token = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
    const spy = vi.spyOn(prisma.stream, "count").mockResolvedValueOnce(3);
    const result = await countStreams({ token });
    expect(result).toBe(3);
    const where = spy.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.token).toBe(token);
  });

  it("countStreams returns zero for a token with no streams", async () => {
    const spy = vi.spyOn(prisma.stream, "count").mockResolvedValueOnce(0);
    const result = await countStreams({
      token: "CNOMATCHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(result).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("countStreams combines token with sender and cancelled filters", async () => {
    const token = "CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const sender = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const spy = vi.spyOn(prisma.stream, "count").mockResolvedValueOnce(0);
    await countStreams({ token, sender, cancelled: true });
    const where = spy.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.token).toBe(token);
    expect(where.sender).toBe(sender);
    expect(where.cancelled).toBe(true);
  });

  it("listStreams omits token from where when filter fields are provided but not token", async () => {
    const spy = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    await listStreams({
      sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      cancelled: true,
    });
    const where = spy.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where).not.toHaveProperty("token");
    expect(where.sender).toBeDefined();
    expect(where.cancelled).toBe(true);
  });
});
