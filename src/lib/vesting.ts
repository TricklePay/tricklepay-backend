// Linear vesting, mirroring the contract's `vesting.rs`. Amounts are token base
// units and times are Unix seconds, both as bigint to match the on-chain
// integer math exactly (including truncating division).
//
// Cancelled streams need no special case here: the contract freezes a cancelled
// stream by setting its total to the vested amount and its end time to the
// cancellation moment, so the same formula yields the frozen balance once the
// stored end time has passed.

/**
 * Computes the total amount of tokens vested in a linear vesting stream at
 * a given point in time (`now`).
 *
 * This arithmetic mirrors the on-chain smart contract's linear vesting
 * calculation in `vesting.rs`.
 *
 * Rounding behavior: Uses truncating integer division (`/` on bigint), which
 * truncates down to the nearest whole token base unit (floor towards zero),
 * matching the on-chain Rust integer division.
 *
 * @param totalAmount - Total allocation for the stream, in smallest token base units.
 * @param startTime - Vesting start time, in Unix seconds.
 * @param endTime - Vesting completion time, in Unix seconds.
 * @param cliffTime - Cliff timestamp, in Unix seconds, before which zero tokens vest.
 * @param now - Current evaluation timestamp, in Unix seconds.
 * @returns Total tokens vested as of `now`, in smallest token base units.
 */
export function vestedAmount(
  totalAmount: bigint,
  startTime: bigint,
  endTime: bigint,
  cliffTime: bigint,
  now: bigint,
): bigint {
  if (now < cliffTime || now < startTime) return 0n;
  if (now >= endTime) return totalAmount;
  const elapsed = now - startTime;
  const duration = endTime - startTime;
  return (totalAmount * elapsed) / duration;
}

/**
 * Computes the remaining unwithdrawn vested token amount available for
 * withdrawal from a stream.
 *
 * This arithmetic mirrors the on-chain smart contract's withdrawable balance
 * calculation in `vesting.rs`, subtracting cumulative withdrawn tokens from
 * cumulative vested tokens and clamping negative results to zero (`0n`).
 *
 * Rounding behavior: Performs exact integer subtraction with no division;
 * results are exact whole token base units with no rounding applied.
 *
 * @param vested - Total cumulative vested token amount, in smallest token base units.
 * @param withdrawn - Total cumulative amount already withdrawn, in smallest token base units.
 * @returns Withdrawable token amount available to claim, in smallest token base units (clamped to a minimum of 0n).
 */
export function withdrawableAmount(vested: bigint, withdrawn: bigint): bigint {
  const available = vested - withdrawn;
  return available < 0n ? 0n : available;
}
