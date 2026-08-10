import { rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { getContractEvents } from "../chain/rpc.js";
import { decodeEvent } from "../chain/events.js";
import { applyEvent } from "./apply.js";
import { getIndexerCursor, saveIndexerCursor } from "../repositories/indexer-state.js";

interface Position {
  cursor?: string;
  startLedger?: number;
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

  private async tick(position: Position): Promise<Position> {
    const page = await getContractEvents(this.server, this.config.contractId, position);

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

    await saveIndexerCursor(page.latestLedger, page.cursor);
    // Once a page is fetched, always continue from its cursor.
    return { cursor: page.cursor };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
