import { rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { EVENT_PAGE_LIMIT, getContractEvents, type EventPage } from "../chain/rpc.js";
import { decodeEvent } from "../chain/events.js";
import { applyEvent } from "./apply.js";
import { getIndexerCursor, saveIndexerCursor } from "../repositories/indexer-state.js";

interface Position {
  cursor?: string;
  startLedger?: number;
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
  private async resolveStart(): Promise<Position> {
    const saved = await getIndexerCursor();
    if (saved?.cursor) {
      this.log.info({ cursor: saved.cursor }, "resuming from saved cursor");
      return { cursor: saved.cursor };
    }
    if (this.config.startLedger > 0) {
      this.log.info({ ledger: this.config.startLedger }, "backfilling from configured ledger");
      return { startLedger: this.config.startLedger };
    }
    const latest = await this.server.getLatestLedger();
    this.log.info({ ledger: latest.sequence }, "starting from latest ledger");
    return { startLedger: latest.sequence };
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
      const page = await getContractEvents(this.server, this.config.contractId, current);
      await this.applyPage(page);
      await saveIndexerCursor(page.latestLedger, page.cursor);

      pages += 1;
      events += page.events.length;
      const drained = isBacklogDrained(page, current.cursor);
      // Once a page is fetched, always continue from its cursor.
      current = { cursor: page.cursor };
      if (drained) break;
    }

    if (pages > 1) {
      this.log.info({ pages, events }, "drained event backlog");
    }
    return current;
  }

  private async applyPage(page: EventPage): Promise<void> {
    for (const raw of page.events) {
      const event = decodeEvent(raw);
      if (!event) continue;
      const outcome = await applyEvent(
        this.server,
        this.config.contractId,
        this.config.networkPassphrase,
        event,
      );
      this.log.info(
        { kind: event.kind, streamId: event.streamId.toString(), ledger: event.ledger, outcome },
        "applied event",
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
