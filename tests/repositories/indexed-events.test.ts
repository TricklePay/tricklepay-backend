import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "../../src/chain/events.js";

import { prisma } from "../../src/db.js";

import {
  indexedEventFromDecoded,
  listIndexedEvents,
  recordIndexedEvent,
  type IndexedEventRecord,
} from "../../src/repositories/indexed-events.js";

describe("indexedEventFromDecoded", () => {
  it("keeps the created-event payload needed for audit trails", () => {
    const event: StreamEvent = {
      kind: "created",
      id: "0000000000000000001",
      ledger: 42,
      closedAt: 123n,
      txHash: "0xabc",
      streamId: 7n,
      sender: "Gsender",
      recipient: "Grecipient",
      token: "CADDR",
      totalAmount: 99n,
      startTime: 10n,
      endTime: 20n,
      cliffTime: 15n,
    };

    expect(indexedEventFromDecoded(event)).toEqual({
      eventId: "0000000000000000001",
      kind: "created",
      streamId: "7",
      ledger: 42,
      txHash: "0xabc",
      sender: "Gsender",
      recipient: "Grecipient",
      token: "CADDR",
      totalAmount: new Prisma.Decimal("99"),
      amount: null,
      recipientAmount: null,
      senderRefund: null,
      startTime: 10n,
      endTime: 20n,
      cliffTime: 15n,
      closedAt: 123n,
    });
  });

  it("keeps delta fields for withdrawn and cancelled events", () => {
    const withdrawnEvent: StreamEvent = {
      kind: "withdrawn",
      id: "0000000000000000002",
      ledger: 43,
      closedAt: 456n,
      txHash: "0xdef",
      streamId: 8n,
      recipient: "Grecipient",
      amount: 11n,
    };

    expect(indexedEventFromDecoded(withdrawnEvent)).toMatchObject({
      eventId: "0000000000000000002",
      kind: "withdrawn",
      streamId: "8",
      totalAmount: null,
      amount: new Prisma.Decimal("11"),
      recipient: "Grecipient",
      closedAt: 456n,
    });

    const cancelledEvent: StreamEvent = {
      kind: "cancelled",
      id: "0000000000000000003",
      ledger: 44,
      closedAt: 789n,
      txHash: "0xghi",
      streamId: 9n,
      recipientAmount: 30n,
      senderRefund: 70n,
    };

    expect(indexedEventFromDecoded(cancelledEvent)).toMatchObject({
      eventId: "0000000000000000003",
      kind: "cancelled",
      streamId: "9",
      totalAmount: null,
      amount: null,
      recipientAmount: new Prisma.Decimal("30"),
      senderRefund: new Prisma.Decimal("70"),
      closedAt: 789n,
    });
  });
});

describe("recordIndexedEvent", () => {
  it("ignores duplicate event ids instead of failing the poller", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      indexedEvent: {
        createMany,
      },
    } as unknown as Prisma.TransactionClient;

    await expect(recordIndexedEvent({
      eventId: "duplicate",
      kind: "created",
      streamId: "1",
      ledger: 7,
      txHash: "0xdup",
      sender: "Gsender",
      recipient: "Grecipient",
      token: "CADDR",
      totalAmount: new Prisma.Decimal("5"),
      amount: null,
      recipientAmount: null,
      senderRefund: null,
      startTime: 1n,
      endTime: 2n,
      cliffTime: 1n,
      closedAt: 3n,
    }, tx)).resolves.toBeUndefined();

    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
    }));
  });
});

describe("recordIndexedEvent idempotency (#222)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves one row unchanged when the same event is recorded twice", async () => {
    const rows = new Map<string, Prisma.IndexedEventCreateManyInput>();
    const createMany = vi
      .spyOn(prisma.indexedEvent, "createMany")
      .mockImplementation((({ data }: { data: Prisma.IndexedEventCreateManyInput | Prisma.IndexedEventCreateManyInput[] }) => {
        const row = Array.isArray(data) ? data[0] : data;
        // Mirror the primary key on eventId plus `skipDuplicates`: an id that
        // is already stored is not written again.
        if (row && rows.has(row.eventId)) return Promise.resolve({ count: 0 }) as ReturnType<typeof prisma.indexedEvent.createMany>;
        if (row) rows.set(row.eventId, row);
        return Promise.resolve({ count: 1 }) as ReturnType<typeof prisma.indexedEvent.createMany>;
      }) as typeof prisma.indexedEvent.createMany);

    const first: IndexedEventRecord = {
      eventId: "0241050272077447168-0000000001",
      kind: "created",
      streamId: "7",
      ledger: 42,
      txHash: "0xabc",
      sender: "Gsender",
      recipient: "Grecipient",
      token: "CADDR",
      totalAmount: new Prisma.Decimal("5"),
      amount: null,
      recipientAmount: null,
      senderRefund: null,
      startTime: 1n,
      endTime: 2n,
      cliffTime: 1n,
      closedAt: 3n,
    };

    await recordIndexedEvent(first);
    // A restart re-reads a page from an earlier cursor, handing over the same
    // event id with staler values; the stored row must survive untouched.
    await recordIndexedEvent({
      ...first,
      ledger: 99,
      txHash: "0xchanged",
      totalAmount: new Prisma.Decimal("999"),
    });

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(1);
    expect(rows.get(first.eventId)).toEqual(first);
  });
});

describe("listIndexedEvents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries by streamId without kind filter when kind is omitted", async () => {
    const findMany = vi
      .spyOn(prisma.indexedEvent, "findMany")
      .mockResolvedValue([]);

    await listIndexedEvents(42n);

    expect(findMany).toHaveBeenCalledWith({
      where: { streamId: "42" },
      orderBy: { eventId: "asc" },
    });
  });

  it("filters by kind when kind is specified", async () => {
    const findMany = vi
      .spyOn(prisma.indexedEvent, "findMany")
      .mockResolvedValue([]);

    await listIndexedEvents(42n, "withdrawn");

    expect(findMany).toHaveBeenCalledWith({
      where: { streamId: "42", kind: "withdrawn" },
      orderBy: { eventId: "asc" },
    });
  });

  it("filters by created kind when kind is created", async () => {
    const findMany = vi
      .spyOn(prisma.indexedEvent, "findMany")
      .mockResolvedValue([]);

    await listIndexedEvents(42n, "created");

    expect(findMany).toHaveBeenCalledWith({
      where: { streamId: "42", kind: "created" },
      orderBy: { eventId: "asc" },
    });
  });

  it("filters by cancelled kind when kind is cancelled", async () => {
    const findMany = vi
      .spyOn(prisma.indexedEvent, "findMany")
      .mockResolvedValue([]);

    await listIndexedEvents(42n, "cancelled");

    expect(findMany).toHaveBeenCalledWith({
      where: { streamId: "42", kind: "cancelled" },
      orderBy: { eventId: "asc" },
    });
  });
});

