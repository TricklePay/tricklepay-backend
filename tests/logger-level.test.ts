import { describe, expect, it } from "vitest";

import { DEFAULT_LOG_LEVEL, LOG_LEVELS, resolveLogLevel } from "../src/logger.js";

// `resolveLogLevel` is the guard that keeps an unrecognised LOG_LEVEL from
// reaching pino, where it would crash the process at import time with a
// message that never mentions the variable (#472).

describe("resolveLogLevel", () => {
  it("accepts every level pino recognises", () => {
    for (const level of LOG_LEVELS) {
      expect(resolveLogLevel(level)).toBe(level);
    }
  });

  it("accepts upper-case spellings and normalizes them", () => {
    expect(resolveLogLevel("DEBUG")).toBe("debug");
    expect(resolveLogLevel("Warn")).toBe("warn");
  });

  it("falls back to the default when unset or blank", () => {
    expect(resolveLogLevel(undefined)).toBe(DEFAULT_LOG_LEVEL);
    expect(resolveLogLevel("   ")).toBe(DEFAULT_LOG_LEVEL);
  });

  it("rejects an unrecognised level with a message naming the variable and the valid levels", () => {
    let error: unknown;
    try {
      resolveLogLevel("verbose");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("LOG_LEVEL");
    expect(message).toContain("verbose");
    for (const level of LOG_LEVELS) {
      expect(message).toContain(level);
    }
  });
});
