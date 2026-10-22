// The contract's stream id is a u64, so the valid range stops here.
export const MAX_UINT64 = 18446744073709551615n;

// Parses a stream id from a route param or query string: a plain decimal
// string within u64 range. Returns null for anything else — missing,
// non-numeric, negative, or too large to be a real on-chain stream id —
// so callers can reject it with a single check rather than letting a
// malformed id reach the database as a query parameter.
export function parseStreamId(raw: string | undefined): bigint | null {
  if (raw === undefined) return null;

  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return null;

  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > MAX_UINT64) return null;
    return parsed;
  } catch {
    return null;
  }
}
