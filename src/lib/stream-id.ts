import { MAX_UINT64, parseUnsignedInteger } from "./unsigned-integer.js";

export { MAX_UINT64 };
export const MAX_STREAM_ID = 9223372036854775807n;

// Parses a stream id from a route param or query string: a plain decimal
// string within the signed BIGINT range used by PostgreSQL.
export function parseStreamId(raw: string | undefined): bigint | null {
  return parseUnsignedInteger(raw, MAX_STREAM_ID);
}

// A decimal id above the database range cannot exist in the stream table.
// Detail routes return 404 for it, while malformed ids still return 400.
export function isStreamIdOutOfRange(raw: string): boolean {
  const value = raw.trim();
  return /^\d+$/.test(value) && BigInt(value) > MAX_STREAM_ID;
}
