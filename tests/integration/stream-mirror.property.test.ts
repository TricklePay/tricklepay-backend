import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../../src/db.js";
import {
  applyCancellation,
  applyWithdrawal,
  insertStream,
} from "../../src/repositories/streams.js";
import { mapStreamResponse } from "../../src/lib/stream-view.js";

const enabled = !!process.env.DATABASE_URL;
const FIRST_STREAM_ID = 581_000_000n;
const SENDER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const RECIPIENT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TOKEN = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
const START = 1_700_000_000n;

/** Small seeded generator: failures are reproducible and no dependency is needed. */
function randomFrom(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % max;
  };
}

/** The contract's integer linear vesting formula, including cliff and truncation. */
function contractVested(total: bigint, start: bigint, end: bigint, cliff: bigint, now: bigint) {
  if (now < start || now < cliff) return 0n;
  if (now >= end) return total;
  return (total * (now - start)) / (end - start);
}

describe("stream mirror lifecycle invariants", () => {
  beforeAll(async () => {
    if (!enabled) return;
    await prisma.stream.deleteMany({
      where: { streamId: { gte: FIRST_STREAM_ID, lt: FIRST_STREAM_ID + 40n } },
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.stream.deleteMany({
      where: { streamId: { gte: FIRST_STREAM_ID, lt: FIRST_STREAM_ID + 40n } },
    });
  });

  it.skipIf(!enabled)("preserves amount and withdrawable invariants for generated valid event sequences", async () => {
    for (let caseIndex = 0; caseIndex < 40; caseIndex++) {
      const random = randomFrom(581_000 + caseIndex);
      const streamId = FIRST_STREAM_ID + BigInt(caseIndex);
      const totalAmount = BigInt(100_000 + random(900_000));
      const duration = BigInt(1_000 + random(2_000));
      const end = START + duration;
      const cliff = START + duration / 8n;
      let sequence = 0;
      let previousTotal = totalAmount;

      const eventId = () => `${String(caseIndex).padStart(4, "0")}-${String(sequence++).padStart(4, "0")}`;
      const ledger = () => 58_100_000 + caseIndex * 10 + sequence;

      const createdId = eventId();
      await insertStream({
        streamId,
        sender: SENDER,
        recipient: RECIPIENT,
        token: TOKEN,
        totalAmount,
        startTime: START,
        endTime: end,
        cliffTime: cliff,
        ledger: ledger(),
        eventId: createdId,
      });

      async function assertMirror(now: bigint, eventKind: "created" | "withdrawn" | "cancelled") {
        const row = await prisma.stream.findUnique({ where: { streamId } });
        expect(row).not.toBeNull();
        const total = BigInt(row!.totalAmount.toString());
        const withdrawn = BigInt(row!.withdrawn.toString());
        expect(withdrawn).toBeGreaterThanOrEqual(0n);
        expect(withdrawn).toBeLessThanOrEqual(total);
        if (total !== previousTotal) {
          expect(eventKind).toBe("cancelled");
          expect(total).toBeLessThan(previousTotal);
        }

        const expectedVested = contractVested(
          total,
          row!.startTime,
          row!.endTime,
          row!.cliffTime,
          now,
        );
        const expectedWithdrawable = expectedVested > withdrawn ? expectedVested - withdrawn : 0n;
        expect(BigInt(mapStreamResponse(row!, now).withdrawable)).toBe(expectedWithdrawable);
        previousTotal = total;
      }

      await assertMirror(START, "created");

      // Generate one to four withdrawals at increasing times. Amounts are
      // bounded by the contract's vested-but-unwithdrawn balance at that time.
      const withdrawalCount = 1 + random(4);
      let withdrawn = 0n;
      for (let step = 1; step <= withdrawalCount; step++) {
        const now = START + (duration * BigInt(step)) / BigInt(withdrawalCount + 2);
        const vested = contractVested(totalAmount, START, end, cliff, now);
        const available = vested - withdrawn;
        if (available <= 0n) continue;
        const amount = 1n + BigInt(random(Number(available)));
        const withdrawalId = eventId();
        expect(await applyWithdrawal({
          streamId,
          amount,
          ledger: ledger(),
          eventId: withdrawalId,
        })).toBe("applied");
        withdrawn += amount;
        await assertMirror(now, "withdrawn");
      }

      const cancelAt = START + (duration * BigInt(withdrawalCount + 1)) / BigInt(withdrawalCount + 2);
      const recipientAmount = contractVested(totalAmount, START, end, cliff, cancelAt) - withdrawn;
      const cancellationId = eventId();
      expect(await applyCancellation({
        streamId,
        recipientAmount,
        cancelledAt: cancelAt,
        ledger: ledger(),
        eventId: cancellationId,
      })).toBe("applied");
      await assertMirror(cancelAt, "cancelled");

      const cancelled = await prisma.stream.findUnique({ where: { streamId } });
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.withdrawn.toString()).toBe(cancelled!.totalAmount.toString());
    }
  });
});
