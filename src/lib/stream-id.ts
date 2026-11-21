import { MAX_UINT64, parseUnsignedInteger } from "./unsigned-integer.js";

export { MAX_UINT64 };

// Parses a stream id from a route param or query string: a plain decimal
// string within u64 range. Returns null for anything else — missing,
// non-numeric, negative, or too large to be a real on-chain stream id —
// so callers can reject it with a single check rather than letting a
// malformed id reach the database as a query parameter.
export function parseStreamId(raw: string | undefined): bigint | null {
  return parseUnsignedInteger(raw, MAX_UINT64);
}
