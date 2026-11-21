import { describe, expect, it } from "vitest";

import { parseCliArgs, wantsJsonOutput } from "../../src/lib/cli-args.js";

// The shared parser behind the prune and replay scripts (#711). Each row lists
// the argv after the script name and the full map the parser must produce.

type Row = {
  name: string;
  argv: string[];
  expected: Array<[string, string | boolean]>;
};

function parsed(argv: string[]): Array<[string, string | boolean]> {
  return [...parseCliArgs(argv).entries()];
}

describe("parseCliArgs", () => {
  const forms: Row[] = [
    { name: "no arguments", argv: [], expected: [] },
    { name: "--flag", argv: ["--dry-run"], expected: [["--dry-run", true]] },
    { name: "--key=value", argv: ["--limit=10"], expected: [["--limit", "10"]] },
    { name: "--key value", argv: ["--limit", "10"], expected: [["--limit", "10"]] },
    {
      name: "all three forms together",
      argv: ["--dry-run", "--limit=10", "--event-id", "abc"],
      expected: [
        ["--dry-run", true],
        ["--limit", "10"],
        ["--event-id", "abc"],
      ],
    },
  ];

  it.each(forms)("parses $name", ({ argv, expected }) => {
    expect(parsed(argv)).toEqual(expected);
  });

  const edgeCases: Row[] = [
    {
      name: "a value containing = splits on the first = only",
      argv: ["--filter=a=b=c"],
      expected: [["--filter", "a=b=c"]],
    },
    {
      name: "a space-separated value containing = is kept whole",
      argv: ["--filter", "a=b"],
      expected: [["--filter", "a=b"]],
    },
    {
      name: "an empty --key= value is the empty string, not a boolean",
      argv: ["--limit="],
      expected: [["--limit", ""]],
    },
    {
      name: "a next token that looks like a flag is not consumed as the value",
      argv: ["--limit", "--dry-run"],
      expected: [
        ["--limit", true],
        ["--dry-run", true],
      ],
    },
    {
      name: "a flag-like value can be passed with --key=value",
      argv: ["--event-id=--dry-run"],
      expected: [["--event-id", "--dry-run"]],
    },
    {
      name: "a single-dash value is consumed as the value",
      argv: ["--offset", "-5"],
      expected: [["--offset", "-5"]],
    },
    {
      name: "a repeated flag keeps the last value",
      argv: ["--limit", "1", "--limit=2"],
      expected: [["--limit", "2"]],
    },
    {
      name: "a repeated flag can change from a value to a boolean",
      argv: ["--limit=1", "--limit"],
      expected: [["--limit", true]],
    },
    {
      name: "a trailing flag is a boolean",
      argv: ["--limit", "10", "--json"],
      expected: [
        ["--limit", "10"],
        ["--json", true],
      ],
    },
    {
      name: "positional arguments and single-dash options are ignored",
      argv: ["positional", "-v", "--dry-run"],
      expected: [["--dry-run", true]],
    },
    {
      name: "flag names are case-sensitive",
      argv: ["--Dry-Run", "--dry-run"],
      expected: [
        ["--Dry-Run", true],
        ["--dry-run", true],
      ],
    },
  ];

  it.each(edgeCases)("$name", ({ argv, expected }) => {
    expect(parsed(argv)).toEqual(expected);
  });

  // Decided behaviour for unknown flags: the parser has no list of known
  // flags, so it stores every `--` argument and leaves validation to the
  // caller. The prune and replay scripts read only the keys they know and
  // ignore the rest; a misspelt flag is therefore silently ignored rather than
  // rejected.
  it("keeps unknown flags in the map without rejecting them", () => {
    const args = parseCliArgs(["--not-a-real-flag", "--other=1", "--dry-run"]);
    expect(args.get("--not-a-real-flag")).toBe(true);
    expect(args.get("--other")).toBe("1");
    expect(args.get("--dry-run")).toBe(true);
  });

  it("keys include the leading dashes", () => {
    const args = parseCliArgs(["--limit=5"]);
    expect(args.has("--limit")).toBe(true);
    expect(args.has("limit")).toBe(false);
  });

  it("reads process.argv after the script path by default", () => {
    const original = process.argv;
    process.argv = ["node", "script.js", "--limit", "7", "--json"];
    try {
      expect([...parseCliArgs().entries()]).toEqual([
        ["--limit", "7"],
        ["--json", true],
      ]);
    } finally {
      process.argv = original;
    }
  });

  it("does not mutate the argv array it is given", () => {
    const argv = ["--limit", "10", "--json"];
    parseCliArgs(argv);
    expect(argv).toEqual(["--limit", "10", "--json"]);
  });
});

describe("wantsJsonOutput", () => {
  const rows: Array<{ name: string; argv: string[]; expected: boolean }> = [
    { name: "--json alone", argv: ["--json"], expected: true },
    { name: "--json among other flags", argv: ["--dry-run", "--json", "--limit=1"], expected: true },
    { name: "--json as a trailing flag after a value", argv: ["--limit", "5", "--json"], expected: true },
    { name: "no --json flag", argv: ["--dry-run"], expected: false },
    { name: "no arguments", argv: [], expected: false },
    { name: "--json=true (a string, not a boolean)", argv: ["--json=true"], expected: false },
    { name: "--json followed by a value it consumes", argv: ["--json", "pretty"], expected: false },
    { name: "a differently cased --JSON", argv: ["--JSON"], expected: false },
    { name: "a bare json positional", argv: ["json"], expected: false },
  ];

  it.each(rows)("$name → $expected", ({ argv, expected }) => {
    expect(wantsJsonOutput(parseCliArgs(argv))).toBe(expected);
  });
});
