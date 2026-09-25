import { describe, it, expect, vi, afterEach } from "vitest";

// Mock pino before importing logger so that it uses process.stdout
vi.mock("pino", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pino")>();
  return {
    default: (opts: any) => (actual as any).default ? (actual as any).default(opts, process.stdout) : (actual as any)(opts, process.stdout)
  };
});

import { logger } from "../src/logger.js";

describe("Logger Configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should honour the configured log level and format", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    
    // The default log level is "info".
    // We expect debug messages to be suppressed and info messages to be emitted.
    logger.debug("This is a debug message");
    logger.info("This is an info message");
    
    // Since it's info level, debug should not have logged anything, 
    // info should have logged exactly once.
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    
    const loggedString = stdoutSpy.mock.calls[0][0] as string;
    const loggedObj = JSON.parse(loggedString);
    
    // Check structured format
    expect(loggedObj).toHaveProperty("level", 30); // pino info level is 30
    expect(loggedObj).toHaveProperty("msg", "This is an info message");
    expect(loggedObj).toHaveProperty("time");
    expect(loggedObj).toHaveProperty("pid");
    expect(loggedObj).toHaveProperty("hostname");
  });
});
