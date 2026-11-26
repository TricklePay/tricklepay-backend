import { afterEach, describe, expect, it, vi } from "vitest";
import { main as pruneMain } from "../../src/indexer/prune.js";
import { main as replayMain } from "../../src/indexer/replay.js";
import { main as printConfigMain, printConfig } from "../../src/print-config.js";

describe("CLI output channels (stdout vs stderr)", () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  describe("prune CLI", () => {
    it("routes usage diagnostics to stderr and leaves stdout empty on missing arguments", async () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      process.argv = ["node", "prune.ts"];
      process.exitCode = undefined;

      await pruneMain();

      expect(process.exitCode).toBe(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalled();
      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("Usage: tsx src/indexer/prune.ts --older-than=<age>");
      expect(output).toContain("Example: tsx src/indexer/prune.ts --older-than=30d --dry-run");
    });
  });

  describe("print-config CLI", () => {
    it("routes diagnostics to stderr and leaves stdout empty when configuration fails to load", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      delete process.env.STREAM_CONTRACT_ID;
      delete process.env.DATABASE_URL;
      process.exitCode = undefined;

      printConfigMain();

      expect(process.exitCode).toBe(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalled();
      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("failed to print configuration: Missing required environment variable");
    });

    it("routes configuration results to stdout as pure JSON and leaves stderr empty when valid", () => {
      const validContractId = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
      process.env.STREAM_CONTRACT_ID = validContractId;
      process.env.DATABASE_URL = "postgresql://tricklepay:tricklepay@localhost:5432/tricklepay";
      process.env.NETWORK = "testnet";

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      process.exitCode = undefined;

      printConfigMain();

      expect(process.exitCode).toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).toHaveBeenCalledTimes(1);

      const output = String(stdoutSpy.mock.calls[0][0]);
      const parsed = JSON.parse(output.trim());
      expect(parsed).toBeDefined();
      expect(parsed.contractId).toBe(validContractId);
      expect(parsed.network).toBe("testnet");
    });

    it("allows passing a custom stream destination to printConfig", () => {
      const validContractId = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
      process.env.STREAM_CONTRACT_ID = validContractId;
      process.env.DATABASE_URL = "postgresql://tricklepay:tricklepay@localhost:5432/tricklepay";

      let captured = "";
      const customStream = {
        write: (chunk: string | Uint8Array) => {
          captured += chunk.toString();
          return true;
        },
      } as unknown as NodeJS.WritableStream;

      printConfig(customStream);

      const parsed = JSON.parse(captured.trim());
      expect(parsed.contractId).toBe(validContractId);
    });
  });

  describe("replay CLI", () => {
    it("routes configuration error to stderr when environment is missing", async () => {
      delete process.env.STREAM_CONTRACT_ID;
      delete process.env.DATABASE_URL;

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      process.exitCode = undefined;

      process.argv = ["node", "replay.ts"];
      await replayMain();

      expect(process.exitCode).toBe(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalled();
      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("configuration error:");
    });
  });
});
