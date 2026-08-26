import { rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { EVENT_PAGE_LIMIT, getContractEvents, type EventPage } from "../chain/rpc.js";
import { decodeEvent, InvalidEventError } from "../chain/events.js";
import { applyEvent } from "./apply.js";
import { prisma } from "../db.js";
import { getIndexerPosition, saveIndexerPosition } from "../repositories/indexer-state.js";
import {
  clearFailedEvent,
  failedEventFromDecoded,
  recordFailedEvent,
} from "../repositories/failed-events.js";
import {
  eventsApplied,
  eventsFailed,
  indexerLagLedgers,
  pagesFetched,
  pollErrors,
  rpcErrors,
} from "../metrics.js";

// The loop's state between ticks: where to read from next, and how far the
// indexer has actually got. `lastLedger` is carried across ticks because a page
// that applies nothing must leave it alone rather than reset it.
interface Position {
  cursor?: string;
  startLedger?: number;
  lastLedger: number;
}

// Whether a page is the end of what the RPC has to give. A page the RPC could
// not fill means there is nothing further right now; a full one means there is
// more behind it and the next page should be fetched immediately.
//
// The cursor is checked too, as a stop for a page that is full but has not
// moved on. Fetching that page again would return the same events forever, so
// it is treated as the end of the backlog and left for the next tick rather
// than retried without pause.
export function isBacklogDrained(page: EventPage, requestedCursor?: string): boolean {
  return page.events.length < EVENT_PAGE_LIMIT || page.cursor === requestedCursor;
}

// Polls the contract for new events and applies them to the database. Runs
// until `stop()` is called. A failed iteration is logged and retried on the
// next tick rather than crashing the loop, so transient RPC errors are
// self-healing.
export class Poller {
  private running = false;
  private readonly log: Logger;

  constructor(
    private readonly server: rpc.Server,
    private readonly config: Config,
    logger: Logger,
  ) {
    this.log = logger.child({ module: "indexer" });
  }

  async start(): Promise<void> {
    this.running = true;
    let position = await this.resolveStart();

    while (this.running) {
      try {
        position = await this.tick(position);
      } catch (err) {
        this.log.error({ err }, "poll iteration failed");
        pollErrors.inc();
      }
      // Checked before sleeping, so a stop does not have to wait out an
      // interval that exists only to pace an idle indexer.
      if (!this.running) break;
      await sleep(this.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  // Picks where to begin: a saved cursor takes precedence, then a configured
  // start ledger for backfill, otherwise the latest ledger to index only new
  // activity.
  //
  // Each case also fixes the floor for `lastLedger`, the position the indexer
  // claims before any event has been applied. Resuming keeps whatever was
  // stored. A backfill has processed nothing at or after its start ledger, so
  // it claims the one below. Starting from the chain's head means deliberately
  // skipping everything before it, so that head is already fully processed.
  private async resolveStart(): Promise<Position> {
    const saved = await getIndexerPosition();
    if (saved?.cursor) {
      this.log.info({ cursor: saved.cursor }, "resuming from saved cursor");
      return { cursor: saved.cursor, lastLedger: saved.lastLedger };
    }
    if (this.config.startLedger > 0) {
      this.log.info({ ledger: this.config.startLedger }, "backfilling from configured ledger");
      return { startLedger: this.config.startLedger, lastLedger: this.config.startLedger - 1 };
    }
    const latest = await this.server.getLatestLedger();
    this.log.info({ ledger: latest.sequence }, "starting from latest ledger");
    return { startLedger: latest.sequence, lastLedger: latest.sequence };
  }

  // Fetches and applies pages until the RPC has nothing further to give, then
  // returns so the loop can sleep. Sleeping between pages would cap indexing at
  // one page per poll interval — twenty events a second at the default, which
  // turns a hundred thousand event backfill into hours of waiting on a timer
  // rather than on the network. A caught-up indexer drains in a single page and
  // sleeps as before, so the interval still governs how often it looks.
  //
  // The cursor is saved after every page, so a backlog interrupted part way
  // through resumes where it stopped rather than starting the tick over.
  private async tick(position: Position): Promise<Position> {
    let current = position;
    let pages = 0;
    let events = 0;

    // `running` is checked between pages as well, so a stop during a long
    // backfill takes effect at the next page boundary instead of at the end of
    // the whole backlog.
    while (this.running) {
      let page: EventPage;
      try {
        page = await getContractEvents(this.server, this.config.contractId, current);
      } catch (err) {
        rpcErrors.inc({ operation: "getContractEvents" });
        throw err;
      }

      // Detect a cursor that moved backwards. The cursor is an opaque string
      // but uses zero-padded TOID-index formatting, so lexicographic
      // comparison matches chain order. A regression means the RPC returned
      // an inconsistent page — applying it would re-process events and
      // corrupt state, so the tick stops and the next poll retries from the
      // last saved position.
      if (current.cursor !== undefined && page.cursor < current.cursor) {
        this.log.warn(
          { previousCursor: current.cursor, regressedCursor: page.cursor },
          "cursor regression detected — skipping page",
        );
        break;
      }

      pagesFetched.inc();
      const nextPosition = await this.applyPage(page, current.lastLedger);
      current = nextPosition;
      pages += 1;
      events += page.events.length;

      const drained = isBacklogDrained(page, position.cursor);
      if (drained) break;
    }

    if (pages > 1) {
      this.log.info({ pages, events }, "drained event backlog");
    }
    return current;
  }

  private async applyPage(page: EventPage, previousLastLedger: number): Promise<Position> {
    let lastLedger = previousLastLedger;

    for (const raw of page.events) {
      let event;
      try {
        event = decodeEvent(raw);
      } catch (err) {
        if (err instanceof InvalidEventError) {
          this.log.warn(
            { err, eventId: raw.id, ledger: raw.ledger },
            "malformed event — skipping",
          );
          eventsFailed.inc({ kind: "malformed" });
          try {
            await recordFailedEvent({
              eventId: raw.id ?? "unknown",
              kind: "malformed",
              streamId: "0",
              ledger: raw.ledger ?? 0,
              error: err.message,
            });
          } catch (recordErr) {
            this.log.warn({ err: recordErr }, "could not persist failed-event record");
          }
          continue;
        }
        throw err;
      }
      if (!event) continue;

      let outcome: string;
      try {
        outcome = await prisma.$transaction(async (tx) => {
          const res = await applyEvent(
            this.server,
            this.config.contractId,
            this.config.networkPassphrase,
            event,
            tx
          );
          await clearFailedEvent(event.id, tx);
          return res;
        });
      } catch (err) {
        // Log the failure and record it in the database so an operator can
        // find it without tailing logs. The event is then skipped so the rest
        // of the page — and the cursor — are not held hostage by one bad event.
        this.log.error(
          { err, kind: event.kind, streamId: event.streamId.toString(), eventId: event.id, ledger: event.ledger },
          "event apply failed — skipping",
        );
        eventsFailed.inc({ kind: event.kind });
        try {
          await recordFailedEvent(failedEventFromDecoded(event, err));
        } catch (recordErr) {
          // Swallow — a failure to record must not mask the original error or
          // block the page from advancing.
          this.log.warn({ err: recordErr }, "could not persist failed-event record");
        }
        continue;
      }

      // The apply succeeded and any stale failed-event row was cleared as part
      // of the transaction.
      this.log.info(
        { kind: event.kind, streamId: event.streamId.toString(), ledger: event.ledger, outcome },
        "applied event",
      );
      // Raised only once the write has landed. If applying throws, the tick
      // aborts without saving, so the page is read again and this ledger is
      // never claimed as processed on the strength of a write that failed.
      lastLedger = Math.max(lastLedger, event.ledger);
      eventsApplied.inc({ kind: event.kind, outcome });
    }

    // `page.latestLedger` is the chain's head, not this indexer's position, so
    // it is stored as such: the two together are what make lag visible.
    await saveIndexerPosition({ lastLedger, chainLedger: page.latestLedger, cursor: page.cursor });

    // Update the lag gauge. Never negative: the indexer's position cannot
    // outrun the chain head that was observed in the same poll.
    indexerLagLedgers.set(Math.max(0, page.latestLedger - lastLedger));

    // Once a page is fetched, always continue from its cursor.
    return { cursor: page.cursor, lastLedger };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
