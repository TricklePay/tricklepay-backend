import { Prisma, PrismaClient } from "@prisma/client";
import { rpc } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replayFailedEvents } from "../../src/indexer/replay.js";
import capture from "../fixtures/get-events.json" with { type: "json" };

// Integration test for the replay command: exercises replay logic against a real
// Postgres database with seeded failed events and a mock RPC server. Verifies
// that successful replays update stream state, clear failed-event records, and
// that not-found events increment failure counts without removing the record.

const url = process.env.DATABASE_URL;
const enabled = !!url;

let prisma: PrismaClient;

const CONTRACT_ID = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
const PASSPHRASE = "Test SDF Network ; September 2015";
const STREAM_ID = 42n;
const WITHDRAWAL_EVENT_ID = "0241383411213664256-0000000001";
const NOT_FOUND_EVENT_ID = "0241383411213664256-9999999999";

const captured = rpc.parseRawEvents(capture.result as unknown as rpc.Api.RawGetEventsResponse);

beforeAll(async () => {
  if (!enabled) return;
  prisma = new PrismaClient({ datasourceUrl: url });
  // Clean up test data
  await prisma.failedEvent.deleteMany({ where: { streamId: STREAM_ID.toString() } });
  await prisma.stream.deleteMany({ where: { streamId: STREAM_ID } });
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  // Clean slate for each test
  await prisma.failedEvent.deleteMany({ where: { streamId: STREAM_ID.toString() } });
  await prisma.stream.deleteMany({ where: { streamId: STREAM_ID } });
});

describe("replay command integration", () => {
  it("replays a failed withdrawal event, updates the stream, and removes the failed-event record", async () => {
    if (!enabled) return;

    // 1. Seed the stream with initial state
    await prisma.stream.create({
      data: {
        streamId: STREAM_ID,
        sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
        totalAmount: new Prisma.Decimal("10000000000"),
        withdrawn: new Prisma.Decimal("0"),
        startTime: 1735689600n,
        endTime: 1767225600n,
        cliffTime: 1740000000n,
        cancelled: false,
        createdLedger: 56_000_000,
        updatedLedger: 56_000_000,
        lastEventId: "0241050272077447168-0000000001",
      },
    });

    // 2. Seed a failed event
    await prisma.failedEvent.create({
      data: {
        eventId: WITHDRAWAL_EVENT_ID,
        kind: "withdrawn",
        streamId: STREAM_ID.toString(),
        ledger: 56201455,
        error: "temporary database failure",
        failureCount: 1,
      },
    });

    // 3. Create a mock RPC server that returns the withdrawal event
    const mockServer = {
      getEvents: async () => ({
        events: [captured.events[1]], // withdrawal event from fixture
        latestLedger: 56999999,
        cursor: "",
      }),
    } as unknown as rpc.Server;

    // 4. Run replay
    const result = await replayFailedEvents(mockServer, CONTRACT_ID, PASSPHRASE, {
      limit: 10,
      dryRun: false,
    });

    // 5. Assert replay succeeded
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // 6. Assert stream was updated
    const stream = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(stream).not.toBeNull();
    expect(stream!.withdrawn.toString()).toBe("2500000000"); // withdrawal amount from fixture
    expect(stream!.lastEventId).toBe(WITHDRAWAL_EVENT_ID);

    // 7. Assert failed-event record was removed
    const failedEvent = await prisma.failedEvent.findUnique({
      where: { eventId: WITHDRAWAL_EVENT_ID },
    });
    expect(failedEvent).toBeNull();
  });

  it("keeps the failed-event record and increments failureCount when event is not found on chain", async () => {
    if (!enabled) return;

    // 1. Seed the stream
    await prisma.stream.create({
      data: {
        streamId: STREAM_ID,
        sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
        totalAmount: new Prisma.Decimal("10000000000"),
        withdrawn: new Prisma.Decimal("0"),
        startTime: 1735689600n,
        endTime: 1767225600n,
        cliffTime: 1740000000n,
        cancelled: false,
        createdLedger: 56_000_000,
        updatedLedger: 56_000_000,
        lastEventId: "0241050272077447168-0000000001",
      },
    });

    // 2. Seed a failed event for an event that doesn't exist on chain
    await prisma.failedEvent.create({
      data: {
        eventId: NOT_FOUND_EVENT_ID,
        kind: "withdrawn",
        streamId: STREAM_ID.toString(),
        ledger: 56201455,
        error: "event not found during initial processing",
        failureCount: 1,
      },
    });

    // 3. Create a mock RPC server that returns no events (not found)
    const mockServer = {
      getEvents: async () => ({
        events: [], // empty - event not found
        latestLedger: 56999999,
        cursor: "",
      }),
    } as unknown as rpc.Server;

    // 4. Run replay
    const result = await replayFailedEvents(mockServer, CONTRACT_ID, PASSPHRASE, {
      limit: 10,
      dryRun: false,
    });

    // 5. Assert replay failed (event not found)
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);

    // 6. Assert stream was NOT updated
    const stream = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(stream).not.toBeNull();
    expect(stream!.withdrawn.toString()).toBe("0"); // unchanged
    expect(stream!.lastEventId).toBe("0241050272077447168-0000000001"); // unchanged

    // 7. Assert failed-event record still exists with incremented failureCount
    const failedEvent = await prisma.failedEvent.findUnique({
      where: { eventId: NOT_FOUND_EVENT_ID },
    });
    expect(failedEvent).not.toBeNull();
    expect(failedEvent!.failureCount).toBe(2); // incremented from 1 to 2
    expect(failedEvent!.error).toContain("not found on chain");
  });

  it("applies a cancelled event correctly during replay", async () => {
    if (!enabled) return;

    const CANCELLED_EVENT_ID = "0241383411213664256-0000000002";

    // 1. Seed the stream with some withdrawn amount
    await prisma.stream.create({
      data: {
        streamId: STREAM_ID,
        sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
        totalAmount: new Prisma.Decimal("10000000000"),
        withdrawn: new Prisma.Decimal("2500000000"),
        startTime: 1735689600n,
        endTime: 1767225600n,
        cliffTime: 1740000000n,
        cancelled: false,
        createdLedger: 56_000_000,
        updatedLedger: 56_000_000,
        lastEventId: WITHDRAWAL_EVENT_ID,
      },
    });

    // 2. Seed a failed cancellation event
    await prisma.failedEvent.create({
      data: {
        eventId: CANCELLED_EVENT_ID,
        kind: "cancelled",
        streamId: STREAM_ID.toString(),
        ledger: 56201456,
        error: "database connection lost",
        failureCount: 1,
      },
    });

    // 3. Create a mock RPC server that returns the cancelled event
    const mockServer = {
      getEvents: async () => ({
        events: [captured.events[2]], // cancelled event from fixture
        latestLedger: 56999999,
        cursor: "",
      }),
    } as unknown as rpc.Server;

    // 4. Run replay
    const result = await replayFailedEvents(mockServer, CONTRACT_ID, PASSPHRASE, {
      limit: 10,
      dryRun: false,
    });

    // 5. Assert replay succeeded
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // 6. Assert stream was cancelled
    const stream = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(stream).not.toBeNull();
    expect(stream!.cancelled).toBe(true);

    // 7. Assert failed-event record was removed
    const failedEvent = await prisma.failedEvent.findUnique({
      where: { eventId: CANCELLED_EVENT_ID },
    });
    expect(failedEvent).toBeNull();
  });

  it("does not double-apply an event that was already applied (idempotence)", async () => {
    if (!enabled) return;

    // 1. Seed the stream with the withdrawal already applied
    await prisma.stream.create({
      data: {
        streamId: STREAM_ID,
        sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
        totalAmount: new Prisma.Decimal("10000000000"),
        withdrawn: new Prisma.Decimal("2500000000"), // already withdrawn
        startTime: 1735689600n,
        endTime: 1767225600n,
        cliffTime: 1740000000n,
        cancelled: false,
        createdLedger: 56_000_000,
        updatedLedger: 56_201_455,
        lastEventId: WITHDRAWAL_EVENT_ID, // event already applied
      },
    });

    // 2. Seed a failed event (spurious - event already applied but record exists)
    await prisma.failedEvent.create({
      data: {
        eventId: WITHDRAWAL_EVENT_ID,
        kind: "withdrawn",
        streamId: STREAM_ID.toString(),
        ledger: 56201455,
        error: "spurious failure after successful apply",
        failureCount: 1,
      },
    });

    // 3. Create a mock RPC server that returns the withdrawal event
    const mockServer = {
      getEvents: async () => ({
        events: [captured.events[1]], // withdrawal event
        latestLedger: 56999999,
        cursor: "",
      }),
    } as unknown as rpc.Server;

    // 4. Run replay
    const result = await replayFailedEvents(mockServer, CONTRACT_ID, PASSPHRASE, {
      limit: 10,
      dryRun: false,
    });

    // 5. Assert replay succeeded (idempotence - duplicate apply is success)
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // 6. Assert stream state unchanged (not double-applied)
    const stream = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(stream).not.toBeNull();
    expect(stream!.withdrawn.toString()).toBe("2500000000"); // still the same, not doubled
    expect(stream!.lastEventId).toBe(WITHDRAWAL_EVENT_ID);

    // 7. Assert failed-event record was removed
    const failedEvent = await prisma.failedEvent.findUnique({
      where: { eventId: WITHDRAWAL_EVENT_ID },
    });
    expect(failedEvent).toBeNull();
  });

  it("dry-run mode does not modify database state", async () => {
    if (!enabled) return;

    // 1. Seed the stream
    await prisma.stream.create({
      data: {
        streamId: STREAM_ID,
        sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        token: "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7",
        totalAmount: new Prisma.Decimal("10000000000"),
        withdrawn: new Prisma.Decimal("0"),
        startTime: 1735689600n,
        endTime: 1767225600n,
        cliffTime: 1740000000n,
        cancelled: false,
        createdLedger: 56_000_000,
        updatedLedger: 56_000_000,
        lastEventId: "0241050272077447168-0000000001",
      },
    });

    // 2. Seed a failed event
    await prisma.failedEvent.create({
      data: {
        eventId: WITHDRAWAL_EVENT_ID,
        kind: "withdrawn",
        streamId: STREAM_ID.toString(),
        ledger: 56201455,
        error: "test error",
        failureCount: 1,
      },
    });

    // 3. Create a mock RPC server
    const mockServer = {
      getEvents: async () => ({
        events: [captured.events[1]],
        latestLedger: 56999999,
        cursor: "",
      }),
    } as unknown as rpc.Server;

    // 4. Run replay in dry-run mode
    const result = await replayFailedEvents(mockServer, CONTRACT_ID, PASSPHRASE, {
      limit: 10,
      dryRun: true,
    });

    // 5. Assert replay reports success but dryRun flag is set
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dryRun).toBe(true);

    // 6. Assert stream was NOT updated
    const stream = await prisma.stream.findUnique({ where: { streamId: STREAM_ID } });
    expect(stream).not.toBeNull();
    expect(stream!.withdrawn.toString()).toBe("0"); // unchanged
    expect(stream!.lastEventId).toBe("0241050272077447168-0000000001"); // unchanged

    // 7. Assert failed-event record still exists
    const failedEvent = await prisma.failedEvent.findUnique({
      where: { eventId: WITHDRAWAL_EVENT_ID },
    });
    expect(failedEvent).not.toBeNull();
    expect(failedEvent!.failureCount).toBe(1); // unchanged
  });
});
