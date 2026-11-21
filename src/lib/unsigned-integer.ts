// The contract's u64 values (stream ids, ledger timestamps) stop here.
export const MAX_UINT64 = 18446744073709551615n;

// The contract stores amounts as i128, so a non-negative amount stops here.
export const MAX_INT128 = 170141183460469231731687303715884105727n;

// Parses a plain decimal string into a bigint between 0 and max, inclusive.
// Surrounding whitespace is ignored. Returns null for anything else — missing,
// empty, signed, decimal, hex, scientific notation, or above max — so every
// caller applies the same rules and differs only in the bound it passes.
export function parseUnsignedInteger(raw: string | undefined, max: bigint): bigint | null {
  if (raw === undefined) return null;

  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return null;

  const parsed = BigInt(value);
  return parsed > max ? null : parsed;
}
