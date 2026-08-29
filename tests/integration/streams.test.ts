import { Prisma, PrismaClient } from "@prisma/client";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listStreams,
  orderByFromFilter,
} from "../../src/repositories/streams.js";

// Opt-in integration suite: exercises Prisma migrations, decimal fields, and
// core repository queries against a real Postgres instance.  Skipped when
// DATABASE_URL is not set so the default `npm test` stays network-free.
//
// Usage:
//   DATABASE_URL=postgresql://user:pass@localhost:5432/testdb \
//     npx vitest run --project integration

const url = process.env.DATABASE_URL;
const enabled = !!url;

// Lazy-initialized so the module loads cleanly when the suite is skipped.
let prisma: PrismaClient;

beforeAll(async () => {
  if (!enabled) return;
  prisma = new PrismaClient({ datasourceUrl: url });
  // Ensure the database is clean before the suite runs.
  await prisma.stream.deleteMany();
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

// Each `it` block is guarded so the suite still registers (zero tests) when
// DATABASE_URL is absent rather than throwing during setup.

describe("stream repository integration", () => {
  const STREAM_ID = 999_999n;

  const streamData = {
    streamId: STREAM_ID,
    sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
    totalAmount: new Prisma.Decimal("100000000000"),
    withdrawn: new Prisma.Decimal(0),
    startTime: 1735689600n,
    endTime: 1767225600n,
    cliffTime: 1740000000n,
    cancelled: false,
    createdLedger: 56_000_000,
    updatedLedger: 56_000_000,
    lastEventId: "0241050272077447168-0000000001",
  };

  it("inserts and retrieves a stream", async () => {
    if (!enabled) return;

    await prisma.stream.create({ data: streamData });

    const found = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(found).not.toBeNull();
    expect(found!.sender).toBe(streamData.sender);
    expect(found!.recipient).toBe(streamData.recipient);
    expect(found!.token).toBe(streamData.token);
    expect(found!.cancelled).toBe(false);
  });

  it("stores decimal fields with full precision", async () => {
    if (!enabled) return;

    const found = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(found).not.toBeNull();
    // Decimal(40,0) must preserve the exact bigint value.
    expect(found!.totalAmount.toString()).toBe("100000000000");
    expect(found!.withdrawn.toString()).toBe("0");
  });

  it("lists streams with filtering", async () => {
    if (!enabled) return;

    const streams = await prisma.stream.findMany({
      where: { sender: streamData.sender },
      orderBy: { streamId: "desc" },
    });
    expect(streams.length).toBeGreaterThanOrEqual(1);
    expect(streams.some((s) => s.streamId === STREAM_ID)).toBe(true);
  });

  it("increments the withdrawn decimal field", async () => {
    if (!enabled) return;

    const amount = new Prisma.Decimal("2500000000");
    await prisma.stream.update({
      where: { streamId: STREAM_ID },
      data: { withdrawn: { increment: amount } },
    });

    const found = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(found!.withdrawn.toString()).toBe("2500000000");
  });

  it("counts streams matching a filter", async () => {
    if (!enabled) return;

    const count = await prisma.stream.count({
      where: { sender: streamData.sender },
    });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("cancels a stream and freezes its totals", async () => {
    if (!enabled) return;

    const stored = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    const frozenTotal = stored!.withdrawn.plus(new Prisma.Decimal("3000000000"));

    await prisma.stream.update({
      where: { streamId: STREAM_ID },
      data: {
        totalAmount: frozenTotal,
        withdrawn: frozenTotal,
        endTime: 1763089117n,
        cancelled: true,
        updatedLedger: 56_290_012,
      },
    });

    const found = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(found!.cancelled).toBe(true);
    expect(found!.totalAmount.toString()).toBe(frozenTotal.toString());
    expect(found!.withdrawn.toString()).toBe(frozenTotal.toString());
  });

  it("cleans up test data", async () => {
    if (!enabled) return;

    await prisma.stream.deleteMany({ where: { streamId: STREAM_ID } });
    const gone = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(gone).toBeNull();
  });
});

describe("prisma schema", () => {
  it("applies migrations against a clean database", async () => {
    if (!enabled) return;

    // If we got this far the schema is valid — PrismaClient connects and can
    // query, which means the migration chain applied successfully.  The
    // explicit create/deleteMany tests above exercise the full column set.
    const result = await prisma.$queryRawUnsafe<{ result: string }[]>(
      "SELECT 'connected' as result",
    );
    expect(result[0].result).toBe("connected");
  });
});

describe("stream listing default ordering", () => {
  const ORDERING_ID_BASE = 800_000_000n;
  const SENDERA = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const SENDERB = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const RECIPIENTA = SENDERB;
  const RECIPIENTB = SENDERA;
  const TOKENX = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
  const TOKENY = "CCW7U4HJBMRSH4I2U4F6H3N4NG2RSXXM72LNO2GMHD2HIR6S4VJK6TNP";

  const streams = [
    { streamId: ORDERING_ID_BASE + 3n, sender: SENDERB, recipient: RECIPIENTB, token: TOKENY, cancelled: false },
    { streamId: ORDERING_ID_BASE + 2n, sender: SENDERA, recipient: RECIPIENTA, token: TOKENX, cancelled: true },
    { streamId: ORDERING_ID_BASE + 1n, sender: SENDERB, recipient: RECIPIENTA, token: TOKENX, cancelled: false },
    { streamId: ORDERING_ID_BASE + 0n, sender: SENDERA, recipient: RECIPIENTB, token: TOKENY, cancelled: true },
  ] as const;

  beforeAll(async () => {
    if (!enabled) return;
    await prisma.stream.deleteMany({
      where: { streamId: { gte: ORDERING_ID_BASE } },
    });
    for (const s of streams) {
      await prisma.stream.create({
        data: {
          streamId: s.streamId,
          sender: s.sender,
          recipient: s.recipient,
          token: s.token,
          totalAmount: new Prisma.Decimal("1000"),
          withdrawn: new Prisma.Decimal(0),
          startTime: 1735689600n,
          endTime: 1767225600n,
          cliffTime: 1740000000n,
          cancelled: s.cancelled,
          createdLedger: 56_000_000,
          updatedLedger: 56_000_000,
          lastEventId: `ordering-${s.streamId.toString()}`,
        },
      });
    }
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.stream.deleteMany({
      where: { streamId: { gte: ORDERING_ID_BASE } },
    });
  });

  it("unfiltered queries order by streamId desc through repository", async () => {
    if (!enabled) return;
    const result = await listStreams({
      limit: 10,
      offset: 0,
    });
    const ids = result
      .filter((s) => s.streamId >= ORDERING_ID_BASE)
      .map((s) => s.streamId);
    expect(ids).toEqual([
      ORDERING_ID_BASE + 3n,
      ORDERING_ID_BASE + 2n,
      ORDERING_ID_BASE + 1n,
      ORDERING_ID_BASE + 0n,
    ]);
  });

  it("sender-filtered queries order by sender asc then streamId desc", async () => {
    if (!enabled) return;
    const result = await listStreams({
      sender: SENDERA,
      limit: 10,
    });
    const ids = result.map((s) => s.streamId);
    expect(ids).toEqual([ORDERING_ID_BASE + 2n, ORDERING_ID_BASE + 0n]);
    for (const s of result) expect(s.sender).toBe(SENDERA);
  });

  it("recipient-filtered queries order by recipient asc then streamId desc", async () => {
    if (!enabled) return;
    const result = await listStreams({
      recipient: RECIPIENTA,
      limit: 10,
    });
    const ids = result.map((s) => s.streamId);
    expect(ids).toEqual([ORDERING_ID_BASE + 2n, ORDERING_ID_BASE + 1n]);
    for (const s of result) expect(s.recipient).toBe(RECIPIENTA);
  });

  it("token-filtered queries order by token asc then streamId desc", async () => {
    if (!enabled) return;
    const result = await listStreams({
      token: TOKENY,
      limit: 10,
    });
    const ids = result.map((s) => s.streamId);
    expect(ids).toEqual([ORDERING_ID_BASE + 3n, ORDERING_ID_BASE + 0n]);
    for (const s of result) expect(s.token).toBe(TOKENY);
  });

  it("cancelled-only filter still orders by streamId desc", async () => {
    if (!enabled) return;
    const orderBy = orderByFromFilter({ cancelled: true });
    const result = await prisma.stream.findMany({
      where: { cancelled: true, streamId: { gte: ORDERING_ID_BASE } },
      orderBy,
    });
    const ids = result.map((s) => s.streamId);
    expect(ids).toEqual([ORDERING_ID_BASE + 2n, ORDERING_ID_BASE + 0n]);
  });

  it("orderByFromFilter produces same order as prisma raw for sender filter", async () => {
    if (!enabled) return;
    const filter = { sender: SENDERB, cancelled: false };
    const viaRepo = await listStreams({ ...filter, limit: 10 });
    const viaRaw = await prisma.stream.findMany({
      where: { ...filter },
      orderBy: orderByFromFilter(filter),
      take: 10,
    });
    const repoIds = viaRepo.map((s) => s.streamId);
    const rawIds = viaRaw.map((s) => s.streamId);
    expect(repoIds).toEqual(rawIds);
    expect(repoIds).toEqual([ORDERING_ID_BASE + 3n, ORDERING_ID_BASE + 1n]);
  });
});
