import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { vestedAmount } from "../../src/lib/vesting.js";

// A shared table of inputs and expected outputs, independent of the hand-written
// cases in vesting.test.ts. See tests/fixtures/README.md for how the vectors are
// derived and how to regenerate them against the contract.

interface VestingVector {
  id: string;
  note: string;
  totalAmount: string;
  startTime: string;
  endTime: string;
  cliffTime: string;
  now: string;
  vested: string;
}

const fixturePath = fileURLToPath(
  new URL("../fixtures/vesting-vectors.json", import.meta.url),
);
const vectors: VestingVector[] = JSON.parse(readFileSync(fixturePath, "utf-8"));

describe("vestedAmount against the shared contract vector table", () => {
  it("has at least 20 vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20);
  });

  it.each(vectors.map((v) => [v.id, v] as const))("%s", (_id, vector) => {
    const result = vestedAmount(
      BigInt(vector.totalAmount),
      BigInt(vector.startTime),
      BigInt(vector.endTime),
      BigInt(vector.cliffTime),
      BigInt(vector.now),
    );
    expect(result, vector.note).toBe(BigInt(vector.vested));
  });
});
