import { rpc } from "@stellar/stellar-sdk";

import { decodeEvent, InvalidEventError } from "../chain/events.js";

import { createRpcServer, EVENT_PAGE_LIMIT, getContractEvents } from "../chain/rpc.js";

import { loadConfig } from "../config.js";

import { prisma } from "../db.js";

import { logger } from "../logger.js";

import {
  clearFailedEvent,
  listFailedEvents,
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
            error: message,
          });
        }
        failed += 1;
        continue;
      }

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
          error: message,
        });
      }
      failed += 1;
    }
  }

  return { attempted, succeeded, failed, dryRun };
}

async function main(): Promise<void> {
  const args = new Map<string, string | boolean>();
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.split("=");
      args.set(key, value ?? true);
    }
  }

  const dryRun = args.get("--dry-run") === true || args.get("--dryRun") === true;
  const rawLimit = args.get("--limit");
  const limit = rawLimit === undefined || rawLimit === true ? 20 : Number(rawLimit);

  const config = loadConfig();
  const server = createRpcServer(config);
  const result = await replayFailedEvents(server, config.contractId, config.networkPassphrase, {
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20,
    dryRun,
  });

  logger.info({
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.failed,
    dryRun: result.dryRun,
  }, "replay finished");

  await prisma.$disconnect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    logger.error({ err }, "failed to replay failed events");
    process.exitCode = 1;
  });
}
