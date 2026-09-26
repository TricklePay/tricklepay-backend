import { afterEach, describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "../../src/chain/events.js";

import { prisma } from "../../src/db.js";

import {
  indexedEventFromDecoded,
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
      totalAmount: 99n,
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
      amount: 11n,
      recipient: "Grecipient",
      closedAt: 456n,
    });
  });
});

describe("recordIndexedEvent", () => {
  it("ignores duplicate event ids instead of failing the poller", async () => {
    const tx = {
      indexedEvent: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;

    await expect(recordIndexedEvent({
      eventId: "duplicate",
      kind: "created",
      streamId: "1",
      ledger: 7,
      txHash: "0xdup",
      sender: "Gsender",
      recipient: "Grecipient",
      token: "CADDR",
      totalAmount: "5" as any,
      amount: null,
      recipientAmount: null,
      senderRefund: null,
      startTime: 1n,
      endTime: 2n,
      cliffTime: 1n,
      closedAt: 3n,
    }, tx)).resolves.toBeUndefined();

    expect(tx.indexedEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
    }));
  });
});

describe("recordIndexedEvent idempotency (#222)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves one row unchanged when the same event is recorded twice", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const createMany = vi
      .spyOn((prisma as any).indexedEvent, "createMany")
      .mockImplementation(async ({ data }: any) => {
        const row = Array.isArray(data) ? data[0] : data;
        // Mirror the primary key on eventId plus `skipDuplicates`: an id that
        // is already stored is not written again.
        if (rows.has(row.eventId)) return { count: 0 };
        rows.set(row.eventId, row);
        return { count: 1 };
      });

    const first: IndexedEventRecord = {
      eventId: "0241050272077447168-0000000001",
      kind: "created",
      streamId: "7",
      ledger: 42,
      txHash: "0xabc",
      sender: "Gsender",
      recipient: "Grecipient",
      token: "CADDR",
      totalAmount: "5" as any,
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
      totalAmount: "999" as any,
    });

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(1);
    expect(rows.get(first.eventId)).toEqual(first);
  });
});
