import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Detect direct CLI invocation without depending on URL percent encoding. */
export function isDirectEntry(moduleUrl: string, argvPath: string | undefined = process.argv[1]): boolean {
  if (argvPath === undefined) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const cliPath = resolve(argvPath);
  if (modulePath === cliPath) return true;
  // Some systems (notably macOS) resolve /tmp to /private/tmp in import.meta.url.
  try {
    return realpathSync(modulePath) === realpathSync(cliPath);
  } catch {
    return false;
  }
}
