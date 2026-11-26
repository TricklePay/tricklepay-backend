import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Shared command-line argument parser used by the prune and replay scripts.
//
// Supports three forms:
//   --flag            → true (boolean)
//   --key=value       → "value"
//   --key value       → "value" (positional next-token when the next arg
//                       does not start with "--")
// ---------------------------------------------------------------------------

/**
 * Returns true if the file identified by `metaUrl` is the script being executed directly.
 * Uses `fileURLToPath(metaUrl)` and `path.resolve(argv1)` to safely handle spaces
 * and percent-encoding in pathnames.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return fileURLToPath(metaUrl) === path.resolve(argv1);
  } catch {
    try {
      const parsed = new URL(metaUrl);
      const decoded = decodeURIComponent(parsed.pathname);
      return path.resolve(decoded) === path.resolve(argv1);
    } catch {
      return false;
    }
  }
}

export const isMain = isMainModule;


/**
 * Parses `process.argv.slice(2)` into a map of flag → value.
 * Boolean flags that appear alone are stored as `true`.
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): Map<string, string | boolean> {
  const args = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      args.set(key, value);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args.set(arg, next);
        i++;
      } else {
        args.set(arg, true);
      }
    }
  }
  return args;
}

/** Returns true when the --json flag is present. */
export function wantsJsonOutput(args: Map<string, string | boolean>): boolean {
  return args.get("--json") === true;
}

export interface CliFlagDef {
  name: string;
  type: "string" | "boolean";
}

export interface CliValidationResult {
  ok: boolean;
  args: Map<string, string | boolean>;
  error?: string;
  isHelp?: boolean;
}

/**
 * Validates CLI arguments against a declared list of allowed flags (#677).
 * Rejects unknown flags (e.g. typos like --dryrun or --older-then),
 * missing values for flags that require values, and unexpected positional arguments.
 * Exits with status 2 and a usage message for errors.
 *
 * Supports:
 *   --key=value
 *   --key value
 *   --flag (boolean)
 *   --help / -h
 */
export function parseAndValidateCli(
  argv: string[] = process.argv.slice(2),
  allowedFlags: readonly CliFlagDef[],
  usage: string,
): CliValidationResult {
  const allowedMap = new Map<string, CliFlagDef>();
  for (const flag of allowedFlags) {
    allowedMap.set(flag.name, flag);
  }

  const acceptsHelp = allowedMap.has("--help") || allowedMap.has("-h");
  const args = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (acceptsHelp && (token === "--help" || token === "-h")) {
      return { ok: true, isHelp: true, args: new Map([["--help", true]]) };
    }

    if (token.startsWith("--")) {
      if (token.includes("=")) {
        const eqIdx = token.indexOf("=");
        const key = token.slice(0, eqIdx);
        const value = token.slice(eqIdx + 1);

        const def = allowedMap.get(key);
        if (!def) {
          return { ok: false, error: `unknown flag: ${key}`, args };
        }

        if (def.type === "boolean") {
          if (value === "true") {
            args.set(key, true);
          } else if (value === "false") {
            args.set(key, false);
          } else {
            return { ok: false, error: `invalid boolean value for ${key}: ${value}`, args };
          }
        } else {
          if (value === "") {
            return { ok: false, error: `missing value for flag ${key}`, args };
          }
          args.set(key, value);
        }
      } else {
        const key = token;
        const def = allowedMap.get(key);
        if (!def) {
          return { ok: false, error: `unknown flag: ${key}`, args };
        }

        if (def.type === "boolean") {
          args.set(key, true);
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("--")) {
            return { ok: false, error: `missing value for flag ${key}`, args };
          }
          args.set(key, next);
          i++;
        }
      }
    } else {
      return { ok: false, error: `unexpected argument: ${token}`, args };
    }
  }

  return { ok: true, args };
}
