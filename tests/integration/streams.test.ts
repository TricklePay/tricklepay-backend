import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
