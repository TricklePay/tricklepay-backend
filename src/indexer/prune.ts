import { prisma } from "../db.js";
import { isMainModule, parseCliArgs, wantsJsonOutput } from "../lib/cli-args.js";
import { pruneFailedEvents, type PruneFailedEventsResult } from "../repositories/failed-events.js";

/**
 * Parses a human-readable age string (e.g. "30d", "60 days", "24h", "30") into a cutoff Date.
 * Numbers with no explicit unit default to days.
 */
export function parseAgeToCutoff(ageStr: string, now = new Date()): Date {
  const trimmed = ageStr.trim().toLowerCase();
  const match = /^(\d+)\s*(d|days?|h|hours?|m|mins?|minutes?|s|secs?|seconds?)?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid --older-than age: "${ageStr}". Expected format like "30d", "60d", "24h", or "30" (days).`,
    );
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Age value must be greater than zero, got "${ageStr}".`);
  }
  const unit = match[2] ?? "d";
  let ms: number;
  if (unit.startsWith("d")) {
    ms = value * 24 * 60 * 60 * 1000;
  } else if (unit.startsWith("h")) {
    ms = value * 60 * 60 * 1000;
  } else if (unit.startsWith("m")) {
    ms = value * 60 * 1000;
  } else if (unit.startsWith("s")) {
    ms = value * 1000;
  } else {
    ms = value * 24 * 60 * 60 * 1000;
  }
  return new Date(now.getTime() - ms);
}

export interface PruneCommandOptions {
  olderThan: string;
  dryRun?: boolean;
}

export async function runPrune(options: PruneCommandOptions): Promise<PruneFailedEventsResult> {
  const cutoff = parseAgeToCutoff(options.olderThan);
  return pruneFailedEvents({ olderThan: cutoff, dryRun: options.dryRun });
}

export async function main(): Promise<void> {
  const args = parseCliArgs();

  const dryRun = args.get("--dry-run") === true || args.get("--dryRun") === true;
  const jsonOutput = wantsJsonOutput(args);
  const rawOlderThan = args.get("--older-than") ?? args.get("--olderThan");

  if (!rawOlderThan || typeof rawOlderThan !== "string") {
    process.stderr.write("Usage: tsx src/indexer/prune.ts --older-than=<age> [--dry-run] [--json]\n");
    process.stderr.write("Example: tsx src/indexer/prune.ts --older-than=30d --dry-run\n");
    process.exitCode = 1;
    return;
  }

  let result: PruneFailedEventsResult;
  try {
    result = await runPrune({ olderThan: rawOlderThan, dryRun });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`prune failed: ${message}\n`);
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify({
        deletedCount: result.deletedCount,
        cutoff: result.cutoff.toISOString(),
        dryRun: result.dryRun,
      }) + "\n",
    );
  } else if (result.dryRun) {
    process.stdout.write(
      `dry-run: ${result.deletedCount} failed event(s) older than ${result.cutoff.toISOString()} would be pruned\n`,
    );
  } else {
    process.stdout.write(
      `pruned ${result.deletedCount} failed event(s) older than ${result.cutoff.toISOString()}\n`,
    );
  }

  await prisma.$disconnect();
}

if (isMainModule(import.meta.url)) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`failed to prune failed events: ${message}\n`);
    process.exitCode = 1;
  });
}
