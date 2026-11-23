// Parsers for the query string parameters accepted by the stream routes.

import { MAX_INT128, MAX_UINT64, parseUnsignedInteger } from "./unsigned-integer.js";

export function parseIncludeTotal(raw: string | undefined): boolean {
  return raw === "true";
}

export function parseCancelled(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

// Parses an `at` Unix timestamp in seconds. Returns null if it is not a u64.
export function parseAtTimestamp(raw: string | undefined): bigint | null {
  return parseUnsignedInteger(raw, MAX_UINT64);
}

// Parses an amount string (non-negative integer). Returns null if invalid, negative, decimal, or non-numeric.
export function parseAmount(raw: string | undefined): bigint | null {
  return parseUnsignedInteger(raw, MAX_INT128);
}
