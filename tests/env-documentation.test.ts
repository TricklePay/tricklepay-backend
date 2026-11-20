import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Every environment variable the service reads must be listed in the README
// configuration table and in `.env.example` (#688). Settings have been added to
// `config.ts` before without either entry, which left operators unable to
// discover them; this test extracts the names from the source and fails,
// naming the missing ones, when the documentation falls behind.

// The modules that read the environment. `loadConfig()` covers almost every
// setting; `server.ts` and `logger.ts` read the few documented in
// docs/CONFIGURATION.md under "Values read outside loadConfig()".
const SOURCE_FILES = ["src/config.ts", "src/server.ts", "src/logger.ts"];

// Variables that are read but deliberately left out of the README and
// `.env.example`, each with the reason. Keep this empty unless a variable
// really should not be configured by operators.
const INTENTIONALLY_UNDOCUMENTED: Record<string, string> = {};

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

/** Names read from the environment by the source files above. */
function variablesReadBySource(): Set<string> {
  const names = new Set<string>();
  for (const file of SOURCE_FILES) {
    const source = read(file);
    // `process.env.NAME` and the injected `env.NAME` in logger.ts.
    for (const name of matchAll(source, /\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(name);
    for (const name of matchAll(source, /\benv\[["']([A-Z][A-Z0-9_]*)["']\]/g)) names.add(name);
    // The typed readers in config.ts: required("NAME"), integer("NAME", …), etc.
    for (const name of matchAll(
      source,
      /\b(?:required|optional|integer|positiveInteger|boolean)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    )) {
      names.add(name);
    }
  }
  return names;
}

/** Names in the first column of the README "Configuration" table. */
function variablesInReadme(): Set<string> {
  const readme = read("README.md");
  const start = readme.indexOf("\n## Configuration");
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);
  return new Set(matchAll(section, /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm));
}

/** Names assigned in `.env.example`, commented out or not. */
function variablesInEnvExample(): Set<string> {
  return new Set(matchAll(read(".env.example"), /^#?\s*([A-Z][A-Z0-9_]*)=/gm));
}

function missingFrom(documented: Set<string>, names: Iterable<string>): string[] {
  return [...names].filter((name) => !documented.has(name)).sort();
}

describe("environment variable documentation", () => {
  const readNames = variablesReadBySource();
  const expected = [...readNames].filter((name) => !(name in INTENTIONALLY_UNDOCUMENTED));

  it("finds the variables read by the source", () => {
    // Guards the extraction itself: if a reader is renamed and the patterns
    // stop matching, the checks below would pass vacuously.
    for (const name of ["DATABASE_URL", "PORT", "ENABLE_DOCS_UI", "CORS_ORIGIN", "LOG_LEVEL"]) {
      expect(readNames, `expected to extract ${name}`).toContain(name);
    }
  });

  it("lists every variable in the README configuration table", () => {
    const missing = missingFrom(variablesInReadme(), expected);
    expect(missing, `missing from the README configuration table: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists every variable in .env.example", () => {
    const missing = missingFrom(variablesInEnvExample(), expected);
    expect(missing, `missing from .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the README table and .env.example in step", () => {
    const readme = variablesInReadme();
    const example = variablesInEnvExample();
    const onlyInReadme = missingFrom(example, readme);
    const onlyInExample = missingFrom(readme, example);
    expect(
      { onlyInReadme, onlyInExample },
      `README table and .env.example disagree — only in README: [${onlyInReadme.join(", ")}], ` +
        `only in .env.example: [${onlyInExample.join(", ")}]`,
    ).toEqual({ onlyInReadme: [], onlyInExample: [] });
  });

  it("does not list a variable as intentionally undocumented that is no longer read", () => {
    const stale = Object.keys(INTENTIONALLY_UNDOCUMENTED).filter((name) => !readNames.has(name)).sort();
    expect(stale, `no longer read by the source: ${stale.join(", ")}`).toEqual([]);
  });
});
