import { mkdtempSync, cpSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isDirectEntry } from "../../src/indexer/direct-entry.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("direct entry detection", () => {
  it("accepts a URL-encoded path containing spaces", () => {
    expect(isDirectEntry("file:///tmp/a%20directory/script.ts", "/tmp/a directory/script.ts")).toBe(true);
  });

  it("rejects imports and absent CLI script arguments", () => {
    expect(isDirectEntry("file:///tmp/a%20directory/script.ts", "/tmp/elsewhere/script.ts")).toBe(false);
    expect(isDirectEntry("file:///tmp/a%20directory/script.ts", undefined)).toBe(false);
  });

  it("runs the real prune CLI from a temporary directory with spaces", () => {
    const folder = mkdtempSync(join(tmpdir(), "tricklepay spaced project "));
    folders.push(folder);
    cpSync(join(root, "src"), join(folder, "src"), { recursive: true });
    copyFileSync(join(root, "package.json"), join(folder, "package.json"));
    symlinkSync(join(root, "node_modules"), join(folder, "node_modules"), "dir");

    const result = spawnSync(
      join(root, "node_modules", ".bin", "tsx"),
      [join(folder, "src", "indexer", "prune.ts")],
      { cwd: folder, encoding: "utf8", timeout: 20000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: tsx src/indexer/prune.ts --older-than=");
  });
});
