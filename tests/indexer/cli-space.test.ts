import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isMainModule } from "../../src/lib/cli-args.js";

const execFileAsync = promisify(execFile);

describe("CLI entrypoint with paths containing spaces", () => {
  it("correctly identifies main module when path contains spaces", () => {
    const metaUrl = "file:///path%20with%20spaces/script.ts";
    const argv1 = path.resolve("/path with spaces/script.ts");
    expect(isMainModule(metaUrl, argv1)).toBe(true);
  });

  it("returns false when paths do not match", () => {
    const metaUrl = "file:///path%20with%20spaces/script.ts";
    const argv1 = path.resolve("/other/path/script.ts");
    expect(isMainModule(metaUrl, argv1)).toBe(false);
  });

  it("runs prune from a temporary directory with a space and expects usage output and exit code 1", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trickle space "));
    try {
      const prunePath = path.resolve("src/indexer/prune.ts");
      let exitCode = 0;
      let stderr = "";
      try {
        await execFileAsync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), prunePath], {
          cwd: tmpDir,
        });
      } catch (err: any) {
        exitCode = err.code ?? 1;
        stderr = err.stderr ?? "";
      }
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Usage: tsx src/indexer/prune.ts");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
