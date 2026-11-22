// Converts a stored stream record into the API view shape.
//
// Keeping the mapper here rather than inline in a route file means every
// endpoint that returns a stream (list, single, future bulk endpoints) shares
// one canonical representation. Adding a field in one place is enough; there
// is no second call site to forget.

import type { Stream } from "@prisma/client";

import { nowSeconds } from "./time.js";
import { vestedAmount, withdrawableAmount } from "./vesting.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

function statusOf(stream: Stream, now: bigint): StreamStatus {
  if (stream.cancelled) return "cancelled";
  if (now < stream.startTime) return "pending";
  if (now >= stream.endTime) return "completed";
  return "streaming";
}

// ---------------------------------------------------------------------------
// Field selection
// ---------------------------------------------------------------------------

// Valid field names that can be requested via the fields parameter.
export const VALID_STREAM_FIELDS = [
  "id",
  "sender",
  "recipient",
  "token",
  "totalAmount",
  "withdrawn",
  "vested",
  "withdrawable",
  "locked",
  "progress",
  "startTime",
  "endTime",
  "cliffTime",
  "cancelled",
  "status",
  "createdLedger",
  "updatedLedger",
] as const;

export type StreamField = (typeof VALID_STREAM_FIELDS)[number];

/**
 * Parses a comma-separated fields string and validates each field name.
 * Returns null if any field is invalid.
 */
export function parseFields(fieldsParam: string | undefined): StreamField[] | null {
  if (!fieldsParam) return null;
  const fields = fieldsParam.split(",").map((f) => f.trim());
  for (const field of fields) {
    if (!VALID_STREAM_FIELDS.includes(field as StreamField)) {
      return null;
    }
  }
  return fields as StreamField[];
}

/**
 * Filters a stream response object to include only the requested fields.
 */
function filterFields<T extends Record<string, unknown>>(
  obj: T,
  fields: StreamField[],
): Partial<T> {
  const result: Partial<T> = {};
  for (const field of fields) {
    if (field in obj) {
      result[field as keyof T] = obj[field as keyof T];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// mapStreamResponse (#363)
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
 * @param asOfTime - Optional Unix timestamp in seconds to evaluate derived vesting fields at.
 * @param fields - Optional list of fields to include in the response. If provided, only these fields are returned.
 * @returns The API-ready view object matching the `StreamView` JSON Schema.
 */
export function mapStreamResponse(
  stream: Stream,
  asOfTime?: bigint,
  fields?: StreamField[] | null,
) {
  const now = typeof asOfTime === "bigint" ? asOfTime : nowSeconds();
  const total = BigInt(stream.totalAmount.toString());
  const withdrawn = BigInt(stream.withdrawn.toString());
  const vested = vestedAmount(total, stream.startTime, stream.endTime, stream.cliffTime, now);
  const withdrawable = withdrawableAmount(vested, withdrawn);
  const locked = total - vested;
  // Vesting progress in basis points, from 0 to 10000, matching the contract.
  const progress = total === 0n ? 10000 : Number((vested * 10000n) / total);

  const full = {
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
    createdLedger: stream.createdLedger,
    updatedLedger: stream.updatedLedger,
  };

  // If fields are specified, return only those fields
  if (fields && fields.length > 0) {
    return filterFields(full, fields);
  }

  return full;
}

/** @deprecated Use mapStreamResponse for new callers. */
export const toView = mapStreamResponse;
