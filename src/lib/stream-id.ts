// The contract's stream id is a u64, so the valid range stops here.
export const MAX_UINT64 = 18446744073709551615n;

const CANONICAL_DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

// Parses a stream id from a route param or query string: a canonical decimal
// string within u64 range (`"0"` or `[1-9][0-9]*`, with no leading zeros or
// surrounding whitespace). Returns null for anything else — missing,
// non-numeric, negative, padded, or too large to be a real on-chain stream id —
// so every stream has one canonical URL and cache key.
export function parseStreamId(raw: string | undefined): bigint | null {
  if (raw === undefined || !CANONICAL_DECIMAL_RE.test(raw)) return null;

  try {
    const parsed = BigInt(raw);
    if (parsed < 0n || parsed > MAX_UINT64) return null;
    return parsed;
  } catch {
    return null;
  }
}
