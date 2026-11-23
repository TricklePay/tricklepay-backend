#!/usr/bin/env node
//
// Renders coverage/coverage-summary.json (Vitest's `json-summary` reporter) as
// a Markdown table with one row per source file. CI appends the output to the
// job summary so per-file coverage is visible without downloading the report.
//
// Usage: node scripts/coverage-summary.mjs [path/to/coverage-summary.json]

import { readFileSync } from "node:fs";
import { relative } from "node:path";

const summaryPath = process.argv[2] ?? "coverage/coverage-summary.json";
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));

const METRICS = ["statements", "branches", "functions", "lines"];

function row(name, entry) {
  const cells = METRICS.map((m) => `${entry[m].pct.toFixed(2)}%`);
  return `| ${name} | ${cells.join(" | ")} |`;
}

const { total, ...files } = summary;

const lines = [
  "## Unit test coverage",
  "",
  "| File | Statements | Branches | Functions | Lines |",
  "| --- | ---: | ---: | ---: | ---: |",
  row("**Total**", total),
  ...Object.keys(files)
    .map((file) => [relative(process.cwd(), file), files[file]])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, entry]) => row(`\`${file}\``, entry)),
  "",
];

process.stdout.write(lines.join("\n"));
