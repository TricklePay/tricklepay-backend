import { rpc } from "@stellar/stellar-sdk";

import { decodeEvent, InvalidEventError } from "../chain/events.js";

import { createRpcServer, EVENT_PAGE_LIMIT, getContractEvents } from "../chain/rpc.js";

import { loadConfig } from "../config.js";

import { prisma } from "../db.js";

import { parseCliArgs, wantsJsonOutput } from "../lib/cli-args.js";

import { logger } from "../logger.js";

import {
  clearFailedEvent,
  getFailedEventById,
  listFailedEvents,
  refreshFailedEventBacklog,
  recordFailedEvent,
  type FailedEventInput,
} from "../repositories/failed-events.js";

import { applyEvent } from "./apply.js";

export interface ReplayFailedEventsOptions {
  limit?: number;
  dryRun?: boolean;
  maxPages?: number;
}

export interface ReplayFailedEventsSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  dryRun: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function findEventForRetry(
  server: rpc.Server,
  contractId: string,
  eventId: string,
  ledger: number,
  maxPages = 20,
) {
  let cursor: string | undefined;
  let startLedger: number | undefined = ledger;
  let pages = 0;

  while (pages < maxPages) {
    const page = await getContractEvents(server, contractId, {
      startLedger,
      cursor,
      limit: EVENT_PAGE_LIMIT,
    });

    for (const raw of page.events) {
      if (raw.id === eventId) {
        return decodeEvent(raw);
      }
    }

    pages += 1;
    if (page.events.length === 0 || page.cursor === "") break;
    cursor = page.cursor;
    startLedger = undefined;
  }

  return null;
}

export async function replayFailedEvents(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  options: ReplayFailedEventsOptions = {},
): Promise<ReplayFailedEventsSummary> {
  const limit = options.limit ?? 20;
  const dryRun = options.dryRun ?? false;
  const maxPages = options.maxPages ?? 20;

  const rows = await listFailedEvents({ limit });
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    attempted += 1;
    let txHash = row.txHash;

    try {
      const event = await findEventForRetry(server, contractId, row.eventId, row.ledger, maxPages);
      if (!event) {
        const message = `event ${row.eventId} not found on chain while replaying failed event`;
        if (dryRun) {
          logger.warn({ eventId: row.eventId, ledger: row.ledger }, "dry-run: would keep failed event record");
        } else {
          await recordFailedEvent({
            eventId: row.eventId,
            kind: row.kind,
            streamId: row.streamId,
            ledger: row.ledger,
            txHash,
            error: message,
          });
        }
        failed += 1;
        continue;
      }

      txHash = event.txHash;
      const applyResult = dryRun
        ? "would-apply"
        : await prisma.$transaction(async (tx) => {
          const result = await applyEvent(
            server,
            contractId,
            networkPassphrase,
            event,
            tx,
          );

          if (result === "applied" || result === "duplicate" || result === "reconciled") {
            await clearFailedEvent({ eventId: event.id }, tx);
            return "success";
          }
          return "missing";
        });

      if (applyResult === "success" || applyResult === "would-apply") {
        succeeded += 1;
        if (!dryRun) {
          logger.info({ eventId: event.id, streamId: event.streamId.toString(), ledger: event.ledger }, "replayed failed event");
        } else {
          logger.info({ eventId: event.id, streamId: event.streamId.toString(), ledger: event.ledger }, "dry-run: would replay failed event");
        }
      } else {
        const message = `could not replay failed event ${event.id}: no stream state to apply`;
        if (dryRun) {
          logger.warn({ eventId: event.id }, "dry-run: would keep failed event record");
        } else {
          await recordFailedEvent({
            eventId: row.eventId,
            kind: row.kind,
            streamId: row.streamId,
            ledger: row.ledger,
            txHash,
            error: message,
          });
        }
        failed += 1;
      }
    } catch (err) {
      const message = `replay failed for ${row.eventId}: ${errorMessage(err)}`;
      if (dryRun) {
        logger.warn({ eventId: row.eventId, ledger: row.ledger, err }, "dry-run: replay would fail");
      } else {
        await recordFailedEvent({
          eventId: row.eventId,
          kind: row.kind,
          streamId: row.streamId,
          ledger: row.ledger,
          txHash,
          error: message,
        });
      }
      failed += 1;
    }
  }

  if (!dryRun) await refreshFailedEventBacklog();

  return { attempted, succeeded, failed, dryRun };
}

export interface ReplayOneFailedEventResult {
  eventId: string;
  outcome: "succeeded" | "failed" | "not-found-in-db" | "not-found-on-chain";
  dryRun: boolean;
}

/**
 * Replays a single failed event identified by its `eventId`.
 * Returns `not-found-in-db` when no row exists with that id (non-zero exit).
 */
export async function replayOneFailedEvent(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  eventId: string,
  options: Pick<ReplayFailedEventsOptions, "dryRun" | "maxPages"> = {},
): Promise<ReplayOneFailedEventResult> {
  const dryRun = options.dryRun ?? false;
  const maxPages = options.maxPages ?? 20;

  const row = await getFailedEventById(eventId);
  if (!row) {
    return { eventId, outcome: "not-found-in-db", dryRun };
  }

  const event = await findEventForRetry(server, contractId, row.eventId, row.ledger, maxPages);
  if (!event) {
    const message = `event ${row.eventId} not found on chain while replaying failed event`;
    if (!dryRun) {
      await recordFailedEvent({
        eventId: row.eventId,
        kind: row.kind,
        streamId: row.streamId,
        ledger: row.ledger,
        error: message,
      });
    } else {
      logger.warn({ eventId: row.eventId, ledger: row.ledger }, "dry-run: would keep failed event record");
    }
    return { eventId, outcome: "not-found-on-chain", dryRun };
  }

  try {
    const applyResult = dryRun
      ? "would-apply"
      : await prisma.$transaction(async (tx) => {
        const result = await applyEvent(server, contractId, networkPassphrase, event, tx);
        if (result === "applied" || result === "duplicate" || result === "reconciled") {
          await clearFailedEvent({ eventId: event.id }, tx);
          return "success";
        }
        return "missing";
      });

    if (applyResult === "success" || applyResult === "would-apply") {
      if (!dryRun) {
        logger.info({ eventId: event.id, streamId: event.streamId.toString(), ledger: event.ledger }, "replayed failed event");
        await refreshFailedEventBacklog();
      } else {
        logger.info({ eventId: event.id, streamId: event.streamId.toString(), ledger: event.ledger }, "dry-run: would replay failed event");
      }
      return { eventId, outcome: "succeeded", dryRun };
    }

    const message = `could not replay failed event ${event.id}: no stream state to apply`;
    if (!dryRun) {
      await recordFailedEvent({
        eventId: row.eventId,
        kind: row.kind,
        streamId: row.streamId,
        ledger: row.ledger,
        error: message,
      });
    } else {
      logger.warn({ eventId: event.id }, "dry-run: would keep failed event record");
    }
    return { eventId, outcome: "failed", dryRun };
  } catch (err) {
    const message = `replay failed for ${row.eventId}: ${errorMessage(err)}`;
    if (!dryRun) {
      await recordFailedEvent({
        eventId: row.eventId,
        kind: row.kind,
        streamId: row.streamId,
        ledger: row.ledger,
        error: message,
      });
    } else {
      logger.warn({ eventId: row.eventId, ledger: row.ledger, err }, "dry-run: replay would fail");
    }
    return { eventId, outcome: "failed", dryRun };
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const dryRun = args.get("--dry-run") === true || args.get("--dryRun") === true;
  const jsonOutput = wantsJsonOutput(args);
  const eventIdArg = args.get("--event-id");
  const eventId = typeof eventIdArg === "string" ? eventIdArg : undefined;

  const config = loadConfig();
  const server = createRpcServer(config);

  if (eventId !== undefined) {
    // Single-event replay mode.
    const result = await replayOneFailedEvent(server, config.contractId, config.networkPassphrase, eventId, { dryRun });

    if (result.outcome === "not-found-in-db") {
      const msg = `event ${eventId} not found in failed events table`;
      if (jsonOutput) {
        process.stdout.write(JSON.stringify({ eventId, outcome: result.outcome, dryRun: result.dryRun, error: msg }) + "\n");
      } else {
        logger.error({ eventId }, msg);
      }
      await prisma.$disconnect();
      process.exitCode = 1;
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ eventId: result.eventId, outcome: result.outcome, dryRun: result.dryRun }) + "\n");
    } else {
      logger.info({ eventId: result.eventId, outcome: result.outcome, dryRun: result.dryRun }, "single-event replay finished");
    }

    if (result.outcome === "failed" || result.outcome === "not-found-on-chain") {
      process.exitCode = 1;
    }
  } else {
    // Bulk replay mode.
    const rawLimit = args.get("--limit");
    const limit = rawLimit === undefined || rawLimit === true ? 20 : Number(rawLimit);

    const result = await replayFailedEvents(server, config.contractId, config.networkPassphrase, {
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20,
      dryRun,
    });

    if (jsonOutput) {
      process.stdout.write(
        JSON.stringify({
          attempted: result.attempted,
          succeeded: result.succeeded,
          failed: result.failed,
          dryRun: result.dryRun,
        }) + "\n",
      );
    } else {
      logger.info({
        attempted: result.attempted,
        succeeded: result.succeeded,
        failed: result.failed,
        dryRun: result.dryRun,
      }, "replay finished");
    }
  }

  await prisma.$disconnect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    logger.error({ err }, "failed to replay failed events");
    process.exitCode = 1;
  });
}
