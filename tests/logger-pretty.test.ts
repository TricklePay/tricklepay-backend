import { describe, expect, it } from "vitest";

import {
  PRETTY_UNAVAILABLE_MESSAGE,
  buildLoggerSetup,
  isPrettyAvailable,
  isPrettyEnabled,
} from "../src/logger.js";

// LOG_PRETTY is an opt-in for local development (#473): it switches the shared
// logger onto the pino-pretty transport. The decision is tested here rather
// than the transport itself, which runs in a worker thread, plus one check that
// the formatter pino-pretty would apply really does produce readable output.

describe("isPrettyEnabled", () => {
  it("recognises the affirmative spellings", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on", " true "]) {
      expect(isPrettyEnabled(value)).toBe(true);
    }
  });

  it("treats anything else, including unset, as off", () => {
    for (const value of [undefined, "", "false", "0", "no", "pretty"]) {
      expect(isPrettyEnabled(value)).toBe(false);
    }
  });
});

describe("buildLoggerSetup", () => {
  it("defaults to JSON with no transport", () => {
    const setup = buildLoggerSetup({}, () => true);

    expect(setup.options.transport).toBeUndefined();
    expect(setup.options.level).toBe("info");
    expect(setup.warning).toBeUndefined();
  });

  it("keeps JSON when LOG_PRETTY is not an affirmative value", () => {
    const setup = buildLoggerSetup({ LOG_PRETTY: "false" }, () => true);

    expect(setup.options.transport).toBeUndefined();
    expect(setup.warning).toBeUndefined();
  });

  it("selects the pino-pretty transport when the option is set and the package is present", () => {
    const setup = buildLoggerSetup({ LOG_PRETTY: "true", LOG_LEVEL: "debug" }, () => true);

    expect(setup.options.transport).toMatchObject({ target: "pino-pretty" });
    expect(setup.options.level).toBe("debug");
    expect(setup.warning).toBeUndefined();
  });

  it("falls back to JSON with a clear warning when pino-pretty is missing", () => {
    const setup = buildLoggerSetup({ LOG_PRETTY: "true" }, () => false);

    expect(setup.options.transport).toBeUndefined();
    expect(setup.warning).toBe(PRETTY_UNAVAILABLE_MESSAGE);
    expect(setup.warning).toContain("LOG_PRETTY");
    expect(setup.warning).toContain("pino-pretty");
  });

  it("finds pino-pretty in a development install", () => {
    // It is declared as a dev dependency, so it must resolve wherever the
    // tests run; a production install omits it and takes the warning path.
    expect(isPrettyAvailable()).toBe(true);
  });
});

describe("pretty output", () => {
  it("renders a log record as a human-readable line instead of JSON", async () => {
    const { prettyFactory } = await import("pino-pretty");
    const format = prettyFactory({ colorize: false, ignore: "pid,hostname" });

    const line = format(
      JSON.stringify({
        level: 30,
        time: Date.parse("2026-01-01T00:00:00.000Z"),
        pid: 1,
        hostname: "host",
        module: "indexer",
        msg: "indexer started",
      }),
    );

    expect(line).toContain("INFO");
    expect(line).toContain("indexer started");
    // The structured spelling is gone: this is the readable rendering.
    expect(line).not.toContain('"msg"');
  });
});
