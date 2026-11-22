import type { Stream } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { mapStreamResponse } from "../../src/lib/stream-view.js";

// The clock is always passed in as `asOfTime`; nothing here reads system time.

function makeStream(overrides: Record<string, unknown> = {}): Stream {
  return {
    streamId: 7n,
    sender: "GSENDER",
    recipient: "GRECIPIENT",
    token: "CTOKEN",
    totalAmount: { toString: () => "1000" },
    withdrawn: { toString: () => "100" },
    startTime: 1000n,
    endTime: 2000n,
    cliffTime: 1000n,
    cancelled: false,
    createdLedger: 11,
    updatedLedger: 22,
    lastEventId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as unknown as Stream;
}

describe("mapStreamResponse", () => {
  it("maps stored fields, turning bigints and amounts into strings", () => {
    const view = mapStreamResponse(makeStream(), 1500n);

    expect(view).toMatchObject({
      id: "7",
      sender: "GSENDER",
      recipient: "GRECIPIENT",
      token: "CTOKEN",
      totalAmount: "1000",
      withdrawn: "100",
      startTime: "1000",
      endTime: "2000",
      cliffTime: "1000",
      cancelled: false,
      createdLedger: 11,
      updatedLedger: 22,
    });
  });

  it("reports a pending stream before its start time", () => {
    const view = mapStreamResponse(makeStream(), 500n);

    expect(view.status).toBe("pending");
    expect(view.vested).toBe("0");
    expect(view.withdrawable).toBe("0");
    expect(view.locked).toBe("1000");
    expect(view.progress).toBe(0);
  });

  it("reports a streaming stream part-way through", () => {
    const view = mapStreamResponse(makeStream(), 1250n);

    expect(view.status).toBe("streaming");
    expect(view.vested).toBe("250");
    expect(view.withdrawable).toBe("150");
    expect(view.locked).toBe("750");
    expect(view.progress).toBe(2500);
  });

  it("is streaming from the start time and vests nothing before the cliff", () => {
    const stream = makeStream({ cliffTime: 1500n });

    const beforeCliff = mapStreamResponse(stream, 1250n);
    expect(beforeCliff.status).toBe("streaming");
    expect(beforeCliff.vested).toBe("0");
    expect(beforeCliff.withdrawable).toBe("0");
    expect(beforeCliff.locked).toBe("1000");
    expect(beforeCliff.progress).toBe(0);

    const atCliff = mapStreamResponse(stream, 1500n);
    expect(atCliff.vested).toBe("500");
    expect(atCliff.withdrawable).toBe("400");
    expect(atCliff.locked).toBe("500");
    expect(atCliff.progress).toBe(5000);
  });

  it("reports a completed stream at and after its end time", () => {
    for (const now of [2000n, 5000n]) {
      const view = mapStreamResponse(makeStream(), now);

      expect(view.status).toBe("completed");
      expect(view.vested).toBe("1000");
      expect(view.withdrawable).toBe("900");
      expect(view.locked).toBe("0");
      expect(view.progress).toBe(10000);
    }
  });

  it("reports a cancelled stream as cancelled whatever the time", () => {
    // The contract freezes a cancelled stream: total becomes the vested amount
    // and the end time becomes the cancellation moment.
    const stream = makeStream({
      cancelled: true,
      totalAmount: { toString: () => "400" },
      endTime: 1400n,
    });

    for (const now of [500n, 1200n, 3000n]) {
      expect(mapStreamResponse(stream, now).status).toBe("cancelled");
    }

    const view = mapStreamResponse(stream, 3000n);
    expect(view.totalAmount).toBe("400");
    expect(view.cancelled).toBe(true);
    expect(view.vested).toBe("400");
    expect(view.withdrawable).toBe("300");
    expect(view.locked).toBe("0");
    expect(view.progress).toBe(10000);
  });

  it("clamps withdrawable to zero when more was withdrawn than has vested", () => {
    const view = mapStreamResponse(
      makeStream({ withdrawn: { toString: () => "600" } }),
      1250n,
    );

    expect(view.vested).toBe("250");
    expect(view.withdrawable).toBe("0");
  });

  it("reports full progress for a stream with a zero total", () => {
    const view = mapStreamResponse(makeStream({ totalAmount: { toString: () => "0" } }), 1250n);

    expect(view.vested).toBe("0");
    expect(view.locked).toBe("0");
    expect(view.progress).toBe(10000);
  });

  it("keeps full precision for amounts beyond Number.MAX_SAFE_INTEGER", () => {
    const total = "170141183460469231731687303715884105727";
    const view = mapStreamResponse(
      makeStream({ totalAmount: { toString: () => total }, withdrawn: { toString: () => "0" } }),
      2000n,
    );

    expect(view.totalAmount).toBe(total);
    expect(view.vested).toBe(total);
    expect(view.withdrawable).toBe(total);
  });
});
