// Totals a set of streams for GET /accounts/:address/summary.

import type { Stream } from "@prisma/client";

import { vestedAmount, withdrawableAmount } from "./vesting.js";

export function summarizeAccountStreams(streams: Stream[], now: bigint) {
  let totalAmount = 0n;
  let withdrawn = 0n;
  let vested = 0n;
  let withdrawable = 0n;

  for (const stream of streams) {
    const streamTotal = BigInt(stream.totalAmount.toString());
    const streamWithdrawn = BigInt(stream.withdrawn.toString());
    const streamVested = vestedAmount(
      streamTotal,
      stream.startTime,
      stream.endTime,
      stream.cliffTime,
      now,
    );
    const streamWithdrawable = withdrawableAmount(streamVested, streamWithdrawn);

    totalAmount += streamTotal;
    withdrawn += streamWithdrawn;
    vested += streamVested;
    withdrawable += streamWithdrawable;
  }

  return {
    count: streams.length,
    totalAmount: totalAmount.toString(),
    total: totalAmount.toString(),
    withdrawn: withdrawn.toString(),
    vested: vested.toString(),
    withdrawable: withdrawable.toString(),
  };
}
