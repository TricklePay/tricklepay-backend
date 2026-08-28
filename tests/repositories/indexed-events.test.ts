import { describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "../../src/chain/events.js";
import {
  indexedEventFromDecoded,
  recordIndexedEvent,
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
      totalAmount: 5n,
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
