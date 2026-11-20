import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Each unit test imports only the modules it needs, so a syntax error or a
// missing export in any other file goes unnoticed until the build breaks. This
// test loads every module under src so such a defect fails here, by name.

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const modules = (readdirSync(srcDir, { recursive: true }) as string[])
  .map((file) => file.split(path.sep).join("/"))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  .sort();

// index.ts starts the service as soon as it is imported. Stop it at the RPC
// check so loading it opens no sockets; every other module loads for real.
vi.mock("../src/chain/rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain/rpc.js")>()),
  verifyRpcEndpoint: vi.fn().mockRejectedValue(new Error("RPC check skipped in test")),
}));

const savedEnv = { ...process.env };
const savedExitCode = process.exitCode;

beforeAll(() => {
  // print-config.ts and index.ts read the configuration when imported.
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/tricklepay";
  process.env.STREAM_CONTRACT_ID = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
  process.env.LOG_LEVEL = "silent";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(() => {
  process.env = savedEnv;
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

describe("every module under src", () => {
  it("finds the source modules", () => {
    expect(modules).toContain("server.ts");
    expect(modules.length).toBeGreaterThan(10);
  });

  it.each(modules)("loads %s", async (file) => {
    const specifier = `../src/${file.replace(/\.ts$/, ".js")}`;
    try {
      await import(/* @vite-ignore */ specifier);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot load src/${file}: ${reason}`, { cause: err });
    }
  });
});
