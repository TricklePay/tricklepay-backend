import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../../src/db.js";
import { main as pruneMain, parseAgeToCutoff, runPrune } from "../../src/indexer/prune.js";
import { pruneFailedEvents } from "../../src/repositories/failed-events.js";

describe("parseAgeToCutoff", () => {
  const baseNow = new Date("2026-10-17T12:00:00.000Z");

  it("parses day-based durations and bare numbers as days", () => {
    const cutoff30d = parseAgeToCutoff("30d", baseNow);
    expect(cutoff30d.getTime()).toBe(baseNow.getTime() - 30 * 24 * 60 * 60 * 1000);

    const cutoffDays = parseAgeToCutoff("7 days", baseNow);
    expect(cutoffDays.getTime()).toBe(baseNow.getTime() - 7 * 24 * 60 * 60 * 1000);

    const cutoffBare = parseAgeToCutoff("14", baseNow);
    expect(cutoffBare.getTime()).toBe(baseNow.getTime() - 14 * 24 * 60 * 60 * 1000);
  });

  it("parses hours, minutes, and seconds", () => {
    const cutoffH = parseAgeToCutoff("24h", baseNow);
    expect(cutoffH.getTime()).toBe(baseNow.getTime() - 24 * 60 * 60 * 1000);

    const cutoffM = parseAgeToCutoff("60m", baseNow);
    expect(cutoffM.getTime()).toBe(baseNow.getTime() - 60 * 60 * 1000);

    const cutoffS = parseAgeToCutoff("3600s", baseNow);
    expect(cutoffS.getTime()).toBe(baseNow.getTime() - 3600 * 1000);
  });

  it("rejects invalid formats and non-positive numbers", () => {
    expect(() => parseAgeToCutoff("invalid")).toThrow(/Invalid --older-than age/);
    expect(() => parseAgeToCutoff("0d")).toThrow(/must be greater than zero/);
    expect(() => parseAgeToCutoff("-5d")).toThrow(/Invalid --older-than age/);
    expect(() => parseAgeToCutoff("")).toThrow(/Invalid --older-than age/);
  });
});

describe("pruneFailedEvents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts matching failed events without deleting when dryRun is true", async () => {
    const cutoff = new Date("2026-09-17T12:00:00.000Z");
    const countSpy = vi.spyOn(prisma.failedEvent, "count").mockResolvedValue(5);
    const deleteManySpy = vi.spyOn(prisma.failedEvent, "deleteMany").mockResolvedValue({ count: 5 });

    const result = await pruneFailedEvents({ olderThan: cutoff, dryRun: true });

    expect(countSpy).toHaveBeenCalledWith({
      where: {
        firstFailedAt: { lt: cutoff },
      },
    });
    expect(deleteManySpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      deletedCount: 5,
      dryRun: true,
      cutoff,
    });
  });

  it("deletes matching failed events and refreshes backlog when dryRun is false", async () => {
    const cutoff = new Date("2026-09-17T12:00:00.000Z");
    const countSpy = vi.spyOn(prisma.failedEvent, "count").mockResolvedValue(2);
    const deleteManySpy = vi.spyOn(prisma.failedEvent, "deleteMany").mockResolvedValue({ count: 8 });

    const result = await pruneFailedEvents({ olderThan: cutoff, dryRun: false });

    expect(deleteManySpy).toHaveBeenCalledWith({
      where: {
        firstFailedAt: { lt: cutoff },
      },
    });
    // refreshFailedEventBacklog calls countFailedEvents which calls count
    expect(countSpy).toHaveBeenCalled();
    expect(result).toEqual({
      deletedCount: 8,
      dryRun: false,
      cutoff,
    });
  });

  it("runPrune resolves age and executes pruning", async () => {
    const countSpy = vi.spyOn(prisma.failedEvent, "count").mockResolvedValue(3);

    const result = await runPrune({ olderThan: "30d", dryRun: true });

    expect(countSpy).toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.deletedCount).toBe(3);
  });

  describe("main CLI stream separation", () => {
    it("writes usage to stderr and exits with code 1 when missing arguments", async () => {
      const origArgv = process.argv;
      const origExitCode = process.exitCode;
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        process.argv = ["node", "prune.js"];
        process.exitCode = undefined;

        await pruneMain();

        expect(process.exitCode).toBe(1);
        expect(stdoutSpy).not.toHaveBeenCalled();
        expect(stderrSpy).toHaveBeenCalled();
        const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(output).toContain("Usage: tsx src/indexer/prune.ts --older-than=<age>");
      } finally {
        process.argv = origArgv;
        process.exitCode = origExitCode;
      }
    });

    it("writes formatted text to stdout and nothing to stderr when in human-readable mode", async () => {
      const origArgv = process.argv;
      const origExitCode = process.exitCode;
      vi.spyOn(prisma.failedEvent, "count").mockResolvedValue(4);
      vi.spyOn(prisma, "$disconnect").mockResolvedValue(undefined as never);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        process.argv = ["node", "prune.js", "--older-than=30d", "--dry-run"];
        process.exitCode = undefined;

        await pruneMain();

        expect(process.exitCode).toBeUndefined();
        expect(stderrSpy).not.toHaveBeenCalled();
        expect(stdoutSpy).toHaveBeenCalled();
        const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(output).toContain("dry-run: 4 failed event(s)");
      } finally {
        process.argv = origArgv;
        process.exitCode = origExitCode;
      }
    });

    it("writes pure JSON to stdout and nothing to stderr when --json is provided", async () => {
      const origArgv = process.argv;
      const origExitCode = process.exitCode;
      vi.spyOn(prisma.failedEvent, "count").mockResolvedValue(7);
      vi.spyOn(prisma, "$disconnect").mockResolvedValue(undefined as never);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        process.argv = ["node", "prune.js", "--older-than=30d", "--dry-run", "--json"];
        process.exitCode = undefined;

        await pruneMain();

        expect(process.exitCode).toBeUndefined();
        expect(stderrSpy).not.toHaveBeenCalled();
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const output = String(stdoutSpy.mock.calls[0][0]);
        const parsed = JSON.parse(output.trim());
        expect(parsed).toEqual({
          deletedCount: 7,
          cutoff: expect.any(String),
          dryRun: true,
        });
      } finally {
        process.argv = origArgv;
        process.exitCode = origExitCode;
      }
    });
  });
});
