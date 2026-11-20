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
  return fileURLToPath(metaUrl) === path.resolve(argv1);
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
