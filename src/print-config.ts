// ---------------------------------------------------------------------------
// Print the effective configuration (#397).
//
// Diagnosing a configuration problem means reasoning about defaults and
// precedence scattered across config.ts. This script resolves the same
// Config loadConfig() would hand the server and prints it, so the answer is
// one command instead of re-deriving it from source.
//
// databaseUrl is the one field that can carry credentials (postgresql://
// user:pass@host/db). The rendering comes from describeConfig, the same one the
// service logs at startup (#474), so this script and that log line agree field
// for field and the credentials are stripped from both. That makes the output
// safe to run against a real environment and to paste into a bug report.
// ---------------------------------------------------------------------------

import { describeConfig, loadConfig } from "./config.js";

function main(): void {
  console.log(JSON.stringify(describeConfig(loadConfig()), null, 2));
}

main();
