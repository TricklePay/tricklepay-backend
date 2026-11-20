// Time and date arithmetic helpers.
//
// Converts ledger timestamps, RFC 3339 date strings, and Javascript timestamps
// into whole Unix seconds represented as bigint or number, providing one
// consistent conversion point across indexer, contract event decoding, and API
// routes.

/**
 * Converts an RFC 3339 timestamp string, Date instance, or millisecond timestamp
 * to whole Unix seconds as a bigint.
 *
 * Truncates fractional seconds (integer division towards zero) to match
 * on-chain contract clocks.
 *
 * Returns `NaN` if the input is an unparseable timestamp string.
 *
 * @param input - An RFC 3339 timestamp string, Date object, or numeric milliseconds.
 * @returns Unix timestamp in whole seconds as bigint, or NaN if unparseable.
 */
export function toUnixSeconds(input: string | Date | number): bigint | typeof NaN {
  const ms =
    typeof input === "string"
      ? Date.parse(input)
      : typeof input === "number"
        ? input
        : input.getTime();
  if (Number.isNaN(ms)) return NaN;
  return BigInt(Math.floor(ms / 1000));
}

/**
 * Returns the current evaluation time in whole Unix seconds as a bigint.
 */
export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}
