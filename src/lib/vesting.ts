// Linear vesting, mirroring the contract's `vesting.rs`. Amounts are token base
// units and times are Unix seconds, both as bigint to match the on-chain
// integer math exactly (including truncating division).
//
// Cancelled streams need no special case here: the contract freezes a cancelled
// stream by setting its total to the vested amount and its end time to the
// cancellation moment, so the same formula yields the frozen balance once the
// stored end time has passed.

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

export function withdrawableAmount(vested: bigint, withdrawn: bigint): bigint {
  const available = vested - withdrawn;
  return available < 0n ? 0n : available;
}
