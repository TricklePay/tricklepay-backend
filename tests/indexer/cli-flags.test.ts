import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { parseAndValidateCli } from "../../src/lib/cli-args.js";
import { PRUNE_ALLOWED_FLAGS, PRUNE_USAGE } from "../../src/indexer/prune.js";
import { REPLAY_ALLOWED_FLAGS, REPLAY_USAGE } from "../../src/indexer/replay.js";

const execFileAsync = promisify(execFile);
const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
const pruneScript = path.resolve("src/indexer/prune.ts");
const replayScript = path.resolve("src/indexer/replay.ts");

async function runCli(script: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [tsxCli, script, ...args]);
    return { exitCode: 0, stdout, stderr };
  } catch (err: any) {
    return {
      exitCode: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("CLI flag validation and parser (#677)", () => {
  describe("unit: parseAndValidateCli", () => {
    it("parses --key value form correctly", () => {
      const result = parseAndValidateCli(
        ["--older-than", "30d", "--dry-run"],
        PRUNE_ALLOWED_FLAGS,
        PRUNE_USAGE,
      );
      expect(result.ok).toBe(true);
      expect(result.args.get("--older-than")).toBe("30d");
      expect(result.args.get("--dry-run")).toBe(true);
    });

    it("parses --key=value form correctly", () => {
      const result = parseAndValidateCli(
        ["--older-than=14d", "--json"],
        PRUNE_ALLOWED_FLAGS,
        PRUNE_USAGE,
      );
      expect(result.ok).toBe(true);
      expect(result.args.get("--older-than")).toBe("14d");
      expect(result.args.get("--json")).toBe(true);
    });

    it("rejects unknown flags / typos", () => {
      const result1 = parseAndValidateCli(
        ["--dryrun", "--older-than=30d"],
        PRUNE_ALLOWED_FLAGS,
        PRUNE_USAGE,
      );
      expect(result1.ok).toBe(false);
      expect(result1.error).toContain("unknown flag: --dryrun");

      const result2 = parseAndValidateCli(
        ["--older-then=30d"],
        PRUNE_ALLOWED_FLAGS,
        PRUNE_USAGE,
      );
      expect(result2.ok).toBe(false);
      expect(result2.error).toContain("unknown flag: --older-then");
    });

    it("rejects missing values for value-expecting flags", () => {
      const result1 = parseAndValidateCli(
        ["--older-than"],
        PRUNE_ALLOWED_FLAGS,
        PRUNE_USAGE,
      );
      expect(result1.ok).toBe(false);
      expect(result1.error).toContain("missing value for flag --older-than");

      const result2 = parseAndValidateCli(
        ["--older-than="],
        PRUNE_ALLOWED_FLAGS,
        PRUNE_USAGE,
      );
      expect(result2.ok).toBe(false);
      expect(result2.error).toContain("missing value for flag --older-than");

      const result3 = parseAndValidateCli(
        ["--older-than", "--dry-run"],
        PRUNE_ALLOWED_FLAGS,
        PRUNE_USAGE,
      );
      expect(result3.ok).toBe(false);
      expect(result3.error).toContain("missing value for flag --older-than");
    });

    it("handles --help and -h flags", () => {
      const help = parseAndValidateCli(["--help"], PRUNE_ALLOWED_FLAGS, PRUNE_USAGE);
      expect(help.isHelp).toBe(true);

      const shortHelp = parseAndValidateCli(["-h"], REPLAY_ALLOWED_FLAGS, REPLAY_USAGE);
      expect(shortHelp.isHelp).toBe(true);
    });
  });

  describe("prune command CLI integration", () => {
    it("prints usage and exits 0 on --help", async () => {
      const { exitCode, stdout } = await runCli(pruneScript, ["--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: tsx src/indexer/prune.ts --older-than=<age>");
      expect(stdout).toContain("--older-than=<age>");
      expect(stdout).toContain("--dry-run");
    });

    it("prints usage and exits 0 on -h", async () => {
      const { exitCode, stdout } = await runCli(pruneScript, ["-h"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: tsx src/indexer/prune.ts");
    });

    it("exits with status 2 and usage on unknown flag typo --dryrun", async () => {
      const { exitCode, stderr } = await runCli(pruneScript, ["--dryrun", "--older-than=30d"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("unknown flag: --dryrun");
      expect(stderr).toContain("Usage: tsx src/indexer/prune.ts");
    });

    it("exits with status 2 and usage on unknown flag typo --older-then", async () => {
      const { exitCode, stderr } = await runCli(pruneScript, ["--older-then=30d"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("unknown flag: --older-then");
      expect(stderr).toContain("Usage: tsx src/indexer/prune.ts");
    });

    it("exits with status 2 and usage on missing value for --older-than", async () => {
      const { exitCode, stderr } = await runCli(pruneScript, ["--older-than"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("missing value for flag --older-than");
      expect(stderr).toContain("Usage: tsx src/indexer/prune.ts");
    });

    it("exits with status 2 and usage on empty value --older-than=", async () => {
      const { exitCode, stderr } = await runCli(pruneScript, ["--older-than="]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("missing value for flag --older-than");
      expect(stderr).toContain("Usage: tsx src/indexer/prune.ts");
    });
  });

  describe("replay command CLI integration", () => {
    it("prints usage and exits 0 on --help", async () => {
      const { exitCode, stdout } = await runCli(replayScript, ["--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: tsx src/indexer/replay.ts");
      expect(stdout).toContain("--limit=<n>");
      expect(stdout).toContain("--event-id=<id>");
    });

    it("prints usage and exits 0 on -h", async () => {
      const { exitCode, stdout } = await runCli(replayScript, ["-h"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: tsx src/indexer/replay.ts");
    });

    it("exits with status 2 and usage on unknown flag typo --dryrun", async () => {
      const { exitCode, stderr } = await runCli(replayScript, ["--dryrun"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("unknown flag: --dryrun");
      expect(stderr).toContain("Usage: tsx src/indexer/replay.ts");
    });

    it("exits with status 2 and usage on unknown flag typo --limt", async () => {
      const { exitCode, stderr } = await runCli(replayScript, ["--limt=10"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("unknown flag: --limt");
      expect(stderr).toContain("Usage: tsx src/indexer/replay.ts");
    });

    it("exits with status 2 and usage on missing value for --limit", async () => {
      const { exitCode, stderr } = await runCli(replayScript, ["--limit"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("missing value for flag --limit");
      expect(stderr).toContain("Usage: tsx src/indexer/replay.ts");
    });

    it("exits with status 2 and usage on missing value for --event-id", async () => {
      const { exitCode, stderr } = await runCli(replayScript, ["--event-id"]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("missing value for flag --event-id");
      expect(stderr).toContain("Usage: tsx src/indexer/replay.ts");
    });
  });
});
