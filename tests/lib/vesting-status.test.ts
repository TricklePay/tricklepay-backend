import { describe, expect, it } from "vitest";

// Issue #63 — Document vesting status boundary semantics.
//
// The status derivation lives in the route handler (statusOf), not the vesting
// helper, so we replicate the exact logic here and pin down every boundary
// transition with a focused test. This is the source-of-truth for how the API
// classifies stream lifecycle states.

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

interface StreamLike {
  startTime: bigint;
  endTime: bigint;
  cancelled: boolean;
}

function statusOf(stream: StreamLike, now: bigint): StreamStatus {
  if (stream.cancelled) return "cancelled";
  if (now < stream.startTime) return "pending";
  if (now >= stream.endTime) return "completed";
  return "streaming";
}

const START = 1000n;
const END = 2000n;

const baseStream: StreamLike = { startTime: START, endTime: END, cancelled: false };

describe("vesting status boundary semantics (#63)", () => {
  describe("pending → streaming transition", () => {
    it("is pending one second before start", () => {
      expect(statusOf(baseStream, START - 1n)).toBe("pending");
    });

    it("is streaming at the exact start instant", () => {
      // now >= startTime (but now < endTime) → streaming
      expect(statusOf(baseStream, START)).toBe("streaming");
    });
  });

  describe("streaming → completed transition", () => {
    it("is streaming one second before end", () => {
      expect(statusOf(baseStream, END - 1n)).toBe("streaming");
    });

    it("is completed at the exact end instant", () => {
      // now >= endTime → completed
      expect(statusOf(baseStream, END)).toBe("completed");
    });

    it("stays completed after end", () => {
      expect(statusOf(baseStream, END + 999n)).toBe("completed");
    });
  });

  describe("cancelled overrides everything", () => {
    it("is cancelled even before start", () => {
      const cancelled: StreamLike = { ...baseStream, cancelled: true };
      expect(statusOf(cancelled, START - 100n)).toBe("cancelled");
    });

    it("is cancelled during the streaming window", () => {
      const cancelled: StreamLike = { ...baseStream, cancelled: true };
      expect(statusOf(cancelled, (START + END) / 2n)).toBe("cancelled");
    });

    it("is cancelled after end", () => {
      const cancelled: StreamLike = { ...baseStream, cancelled: true };
      expect(statusOf(cancelled, END + 100n)).toBe("cancelled");
    });
  });

  describe("cancelled stream with frozen endTime", () => {
    it("cancelled stream's endTime is the cancellation moment", () => {
      // The contract freezes endTime at cancellation. Even though the
      // original endTime was later, the stored endTime is now the freeze point.
      const frozenEnd = 1500n;
      const cancelled: StreamLike = { startTime: START, endTime: frozenEnd, cancelled: true };
      // After the frozen end, status is still "cancelled" (cancelled check runs first).
      expect(statusOf(cancelled, frozenEnd + 1n)).toBe("cancelled");
    });
  });

  describe("edge: zero-length stream (start == end)", () => {
    it("is completed immediately at start == end", () => {
      const instant: StreamLike = { startTime: 500n, endTime: 500n, cancelled: false };
      // now >= endTime and now >= startTime → completed
      expect(statusOf(instant, 500n)).toBe("completed");
    });

    it("is pending one second before the instant", () => {
      const instant: StreamLike = { startTime: 500n, endTime: 500n, cancelled: false };
      expect(statusOf(instant, 499n)).toBe("pending");
    });
  });
});
