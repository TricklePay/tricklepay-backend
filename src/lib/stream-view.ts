// Converts a stored stream record into the API view shape.
//
// Keeping the mapper here rather than inline in a route file means every
// endpoint that returns a stream (list, single, future bulk endpoints) shares
// one canonical representation. Adding a field in one place is enough; there
// is no second call site to forget.

import type { Stream } from "@prisma/client";

import { vestedAmount, withdrawableAmount } from "./vesting.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function statusOf(stream: Stream, now: bigint): StreamStatus {
  if (stream.cancelled) return "cancelled";
  if (now < stream.startTime) return "pending";
  if (now >= stream.endTime) return "completed";
  return "streaming";
}

// ---------------------------------------------------------------------------
// toView (#158)
// ---------------------------------------------------------------------------

/**
 * Shapes a stored stream record into the API response object, computing
 * live derived fields (vested, withdrawable, locked, progress, status)
 * against the current clock so clients see up-to-date figures without
 * querying the chain.
 *
 * All token amounts are returned as decimal strings to preserve the full
 * 128-bit precision used by the contract.
 *
 * @param stream - The raw stream row from the database.
 * @returns The API-ready view object matching the `StreamView` JSON Schema.
 */
export function toView(stream: Stream) {
  const now = nowSeconds();
  const total = BigInt(stream.totalAmount.toString());
  const withdrawn = BigInt(stream.withdrawn.toString());
  const vested = vestedAmount(total, stream.startTime, stream.endTime, stream.cliffTime, now);
  const withdrawable = withdrawableAmount(vested, withdrawn);
  const locked = total - vested;
  // Vesting progress in basis points, from 0 to 10000, matching the contract.
  const progress = total === 0n ? 10000 : Number((vested * 10000n) / total);

  return {
    id: stream.streamId.toString(),
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    totalAmount: total.toString(),
    withdrawn: withdrawn.toString(),
    vested: vested.toString(),
    withdrawable: withdrawable.toString(),
    locked: locked.toString(),
    progress,
    startTime: stream.startTime.toString(),
    endTime: stream.endTime.toString(),
    cliffTime: stream.cliffTime.toString(),
    cancelled: stream.cancelled,
    status: statusOf(stream, now),
  };
}
