// Samples a stream's vesting curve into points for GET /streams/:id/schedule.

import type { Stream } from "@prisma/client";

import { vestedAmount } from "./vesting.js";

export const DEFAULT_SCHEDULE_POINTS = 50;
export const MIN_SCHEDULE_POINTS = 2;
export const MAX_SCHEDULE_POINTS = 100;

export function computeSchedulePoints(stream: Stream, targetPoints = DEFAULT_SCHEDULE_POINTS) {
  const count = Math.max(MIN_SCHEDULE_POINTS, Math.min(targetPoints, MAX_SCHEDULE_POINTS));
  const startTime = stream.startTime;
  const endTime = stream.endTime;
  const cliffTime = stream.cliffTime;
  const total = BigInt(stream.totalAmount.toString());

  if (endTime <= startTime) {
    const v = vestedAmount(total, startTime, endTime, cliffTime, startTime);
    return [
      {
        time: startTime.toString(),
        amount: v.toString(),
        vested: v.toString(),
      },
    ];
  }

  const duration = endTime - startTime;
  const hasCliff = cliffTime > startTime && cliffTime < endTime;

  const candidateTimes = new Set<bigint>();
  for (let i = 0; i < count; i++) {
    const t = startTime + (duration * BigInt(i)) / BigInt(count - 1);
    candidateTimes.add(t);
  }

  if (hasCliff && !candidateTimes.has(cliffTime)) {
    let closest: bigint | null = null;
    let minDiff: bigint | null = null;
    for (const t of candidateTimes) {
      if (t === startTime || t === endTime) continue;
      const diff = t > cliffTime ? t - cliffTime : cliffTime - t;
      if (minDiff === null || diff < minDiff) {
        minDiff = diff;
        closest = t;
      }
    }
    if (closest !== null) {
      candidateTimes.delete(closest);
    }
    candidateTimes.add(cliffTime);
  }

  const sortedTimes = Array.from(candidateTimes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return sortedTimes.map((t) => {
    const v = vestedAmount(total, startTime, endTime, cliffTime, t);
    return {
      time: t.toString(),
      amount: v.toString(),
      vested: v.toString(),
    };
  });
}
