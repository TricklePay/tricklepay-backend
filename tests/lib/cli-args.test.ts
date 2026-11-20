import { describe, expect, it } from "vitest";

import { parseCliArgs, wantsJsonOutput } from "../../src/lib/cli-args.js";

// Table-driven tests for the shared command-line parser used by the prune and
// replay scripts (#711). Each case lists the argv tokens (without the node and
// script paths) and the exact map the parser must produce.

type Case = {
  name: string;
  argv: string[];
  expected: Array<[string, string | boolean]>;
};

const forms: Case[] = [
  { name: "no arguments", argv: [], expected: [] },
  { name: "bare --flag", argv: ["--dry-run"], expected: [["--dry-run", true]] },
  { name: "--key=value", argv: ["--limit=10"], expected: [["--limit", "10"]] },
  { name: "--key value", argv: ["--limit", "10"], expected: [["--limit", "10"]] },
  {
    name: "all three forms together",
    argv: ["--dry-run", "--limit=10", "--older-than", "7d"],
    expected: [
      ["--dry-run", true],
      ["--limit", "10"],
      ["--older-than", "7d"],
    ],
  },
];

const edgeCases: Case[] = [
  {
    name: "value containing = keeps everything after the first =",
    argv: ["--filter=a=b=c"],
    expected: [["--filter", "a=b=c"]],
  },
  {
    name: "empty value after = is an empty string, not a boolean",
    argv: ["--limit="],
    expected: [["--limit", ""]],
  },
  {
    name: "a following token that looks like a flag is not consumed as the value",
    argv: ["--limit", "--json"],
    expected: [
      ["--limit", true],
      ["--json", true],
    ],
  },
  {
    name: "a single-dash token is consumed as a value (only -- marks a flag)",
    argv: ["--offset", "-5"],
    expected: [["--offset", "-5"]],
  },
  {
    name: "repeated flags keep the last value",
    argv: ["--limit", "1", "--limit=2", "--limit", "3"],
    expected: [["--limit", "3"]],
  },
  {
    name: "a repeated flag can switch from a value to a boolean",
    argv: ["--limit=5", "--limit"],
    expected: [["--limit", true]],
  },
  {
    name: "a trailing flag with no value is a boolean",
    argv: ["--limit", "10", "--json"],
    expected: [
      ["--limit", "10"],
      ["--json", true],
    ],
  },
  {
    name: "positional tokens not following a flag are ignored",
    argv: ["stray", "--json", "--limit", "10", "extra"],
    expected: [
      ["--json", true],
      ["--limit", "10"],
    ],
  },
  {
    name: "single-dash short options are ignored",
    argv: ["-v", "--json"],
    expected: [["--json", true]],
  },
  {
    name: "a bare -- token is stored as a flag named --",
    argv: ["--"],
    expected: [["--", true]],
  },
  // Unknown flags: the parser has no allow-list, so any --name is accepted and
  // returned as-is. Each script reads only the keys it knows, which means a
  // misspelt flag is silently ignored. If unknown flags become an error, this
  // case is the one to update.
  {
    name: "unknown flags are accepted and returned unchanged",
    argv: ["--not-a-real-flag", "--also-unknown=1"],
    expected: [
      ["--not-a-real-flag", true],
      ["--also-unknown", "1"],
    ],
  },
];

describe("parseCliArgs", () => {
  describe.each([
    ["supported forms", forms],
    ["edge cases", edgeCases],
  ])("%s", (_group, cases) => {
    it.each(cases)("$name", ({ argv, expected }) => {
      expect([...parseCliArgs(argv)]).toEqual(expected);
    });
  });

  it("does not mutate the argv array it is given", () => {
    const argv = ["--limit", "10", "--json"];
    parseCliArgs(argv);
    expect(argv).toEqual(["--limit", "10", "--json"]);
  });

  it("defaults to process.argv.slice(2)", () => {
    const original = process.argv;
    process.argv = ["node", "script.js", "--json", "--limit=3"];
    try {
      expect([...parseCliArgs()]).toEqual([
        ["--json", true],
        ["--limit", "3"],
      ]);
    } finally {
      process.argv = original;
    }
  });
});

describe("wantsJsonOutput", () => {
  it.each([
    { argv: ["--json"], expected: true },
    { argv: ["--limit", "10", "--json"], expected: true },
    { argv: ["--json", "--limit", "10"], expected: true },
    { argv: [], expected: false },
    { argv: ["--limit", "10"], expected: false },
    // Only the bare boolean form enables JSON output; an explicit value is not
    // interpreted, so --json=true is not the same as --json.
    { argv: ["--json=true"], expected: false },
    { argv: ["--json=false"], expected: false },
    // A positional token after --json is consumed as its value, which turns
    // JSON output off. Put --json last or use it before another --flag.
    { argv: ["--json", "extra"], expected: false },
    { argv: ["--JSON"], expected: false },
  ])("$argv → $expected", ({ argv, expected }) => {
    expect(wantsJsonOutput(parseCliArgs(argv))).toBe(expected);
  });
});
