import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Logger Configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should honour the configured log level and format", () => {
    const logger = pino({ level: "info" }, process.stdout);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // This test opts back in to logging explicitly so it can assert on the
    // output format without depending on the silent default for the unit project.
    logger.debug("This is a debug message");
    logger.info("This is an info message");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    const loggedString = stdoutSpy.mock.calls[0][0] as string;
    const loggedObj = JSON.parse(loggedString);

    expect(loggedObj).toHaveProperty("level", 30);
    expect(loggedObj).toHaveProperty("msg", "This is an info message");
    expect(loggedObj).toHaveProperty("time");
    expect(loggedObj).toHaveProperty("pid");
    expect(loggedObj).toHaveProperty("hostname");
  });
});
