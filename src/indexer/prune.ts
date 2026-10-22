import { prisma } from "../db.js";
import { parseCliArgs, wantsJsonOutput } from "../lib/cli-args.js";
import { logger } from "../logger.js";
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

async function main(): Promise<void> {
  const args = parseCliArgs();

  const dryRun = args.get("--dry-run") === true || args.get("--dryRun") === true;
  const jsonOutput = wantsJsonOutput(args);
  const rawOlderThan = args.get("--older-than") ?? args.get("--olderThan");

  if (!rawOlderThan || typeof rawOlderThan !== "string") {
    console.error("Usage: tsx src/indexer/prune.ts --older-than=<age> [--dry-run] [--json]");
    console.error("Example: tsx src/indexer/prune.ts --older-than=30d --dry-run");
    process.exitCode = 1;
    return;
  }

  const result = await runPrune({ olderThan: rawOlderThan, dryRun });

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify({
        deletedCount: result.deletedCount,
        cutoff: result.cutoff.toISOString(),
        dryRun: result.dryRun,
      }) + "\n",
    );
  } else if (result.dryRun) {
    logger.info(
      { deletedCount: result.deletedCount, cutoff: result.cutoff.toISOString(), dryRun: true },
      `dry-run: ${result.deletedCount} failed event(s) older than ${result.cutoff.toISOString()} would be pruned`,
    );
  } else {
    logger.info(
      { deletedCount: result.deletedCount, cutoff: result.cutoff.toISOString(), dryRun: false },
      `pruned ${result.deletedCount} failed event(s) older than ${result.cutoff.toISOString()}`,
    );
  }

  await prisma.$disconnect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    logger.error({ err }, "failed to prune failed events");
    process.exitCode = 1;
  });
}
