import { rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { getContractEvents } from "../chain/rpc.js";
import { decodeEvent } from "../chain/events.js";
import { applyEvent } from "./apply.js";
import { getIndexerPosition, saveIndexerPosition } from "../repositories/indexer-state.js";

// The loop's state between ticks: where to read from next, and how far the
// indexer has actually got. `lastLedger` is carried across ticks because a page
// that applies nothing must leave it alone rather than reset it.
interface Progress {
  cursor?: string;
  startLedger?: number;
  lastLedger: number;
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
    let progress = await this.resolveStart();

    while (this.running) {
      try {
        progress = await this.tick(progress);
      } catch (err) {
        this.log.error({ err }, "poll iteration failed");
      }
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
  private async resolveStart(): Promise<Progress> {
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

  private async tick(progress: Progress): Promise<Progress> {
    const page = await getContractEvents(this.server, this.config.contractId, {
      cursor: progress.cursor,
      startLedger: progress.startLedger,
    });

    let lastLedger = progress.lastLedger;
    for (const raw of page.events) {
      const event = decodeEvent(raw);
      if (!event) continue;
      await applyEvent(this.server, this.config.contractId, this.config.networkPassphrase, event);
      // Raised only once the write has landed. If applying throws, the tick
      // aborts without saving, so the page is read again and this ledger is
      // never claimed as processed on the strength of a write that failed.
      lastLedger = Math.max(lastLedger, event.ledger);
      this.log.info(
        { kind: event.kind, streamId: event.streamId.toString(), ledger: event.ledger },
        "applied event",
      );
    }

    // `page.latestLedger` is the chain's head, not this indexer's position, so
    // it is stored as such: the two together are what make lag visible.
    await saveIndexerPosition({ lastLedger, chainLedger: page.latestLedger, cursor: page.cursor });
    // Once a page is fetched, always continue from its cursor.
    return { cursor: page.cursor, lastLedger };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
