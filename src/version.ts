import { createRequire } from "node:module";

// Service version reported by /health so deployment tooling can distinguish
// binaries during rolling releases (#76). The value comes from the package
// manifest — the same file that is carried into the runtime image (see the
// Dockerfile) — with a safe fallback if it cannot be read.
const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  try {
    const pkg = require("../package.json") as { version?: string };
    return typeof pkg.version === "string" && pkg.version !== ""
      ? pkg.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export const serviceVersion = readPackageVersion();
