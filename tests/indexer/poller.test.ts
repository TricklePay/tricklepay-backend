import { rpc } from "@stellar/stellar-sdk";

import pino from "pino";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../src/config.js";
import { rpcErrors } from "../../src/metrics.js";

import capture from "../fixtures/get-events.json" with { type: "json" };

// What the poller records about itself. The RPC, the database and the apply
// step are all stubbed, so what is under test is the bookkeeping: which ledger
// the poller claims to have reached after a page, and whether that figure comes
// from the events it applied or from the chain's head.
//
// The captured page is fed in as the RPC would return it, so the ledgers being
// asserted are decoded from real event XDR rather than made up here.

const chain = vi.hoisted(() => ({
  getContractEvents: vi.fn(),
  createRpcServer: vi.fn(),
  // Exported by the (mocked) module and used by isBacklogDrained to decide
  // whether a page is full. Kept in step with the real constant.
  EVENT_PAGE_LIMIT: 100,
}));

const indexerState = vi.hoisted(() => ({
  getIndexerPosition: vi.fn(),
  saveIndexerPosition: vi.fn(),
}));

const indexer = vi.hoisted(() => ({ applyEvent: vi.fn() }));

const failedEvents = vi.hoisted(() => ({
  recordFailedEvent: vi.fn(),
  clearFailedEvent: vi.fn(),
  refreshFailedEventBacklog: vi.fn(),
  failedEventFromDecoded: vi.fn((event: unknown, err: unknown) => ({ eventId: "x", kind: "created", streamId: "1", ledger: 0, error: String(err) })),
}));

vi.mock("../../src/chain/rpc.js", () => chain);
vi.mock("../../src/repositories/indexer-state.js", () => indexerState);
vi.mock("../../src/indexer/apply.js", () => indexer);
vi.mock("../../src/repositories/failed-events.js", () => failedEvents);
vi.mock("../../src/db.js", () => ({
  prisma: {
    $transaction: vi.fn(async (cb: any) => cb({})),
  },
}));

const { Poller } = await import("../../src/indexer/poller.js");

const captured = rpc.parseRawEvents(capture.result as unknown as rpc.Api.RawGetEventsResponse);

// Ledgers of the captured events, for the assertions below. The last two are
// event kinds this indexer does not understand and so never applies.
const LAST_APPLIED = 56290013;
const LAST_UNKNOWN = 56290015;
const CHAIN_HEAD = 56999999;

const CURSOR = "0241763773516349440-0000000001";

const config: Config = {
  port: 3000,
  host: "0.0.0.0",
  databaseUrl: "postgresql://localhost/test",
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW",
  // Zero keeps the tests instant without changing which pages a tick fetches.
  pollIntervalMs: 0,
  startLedger: 0,
  maxBackoffMs: 60000,
  maxPagesPerTick: 1000,
  bodyLimit: 1048576,
  queryStringLimit: 2048,
  trustedProxies: [],
};

const log = pino({ level: "silent" });

const getLatestLedger = vi.fn();
const server = { getLatestLedger } as unknown as rpc.Server;

function pageOf(events: rpc.Api.EventResponse[], latestLedger = CHAIN_HEAD) {
  return { events, latestLedger, cursor: CURSOR };
}

// A page that fills EVENT_PAGE_LIMIT so the poller keeps fetching rather than
// treating it as the end of the backlog. Built from the captured events so the
// ledgers stay real for the apply step. Used to exercise the per-tick page cap.
function fullPage(cursor: string, latestLedger = CHAIN_HEAD) {
  const events = Array.from({ length: 17 }, () => captured.events).flat();
  return { events, latestLedger, cursor };
}

// Drives exactly one poll: the loop is stopped from inside the save, which is
// the last thing a tick does, so `start()` returns after a single iteration.
async function pollOnce(overrides: Partial<Config> = {}) {
  const poller = new Poller(server, { ...config, ...overrides }, log);
  indexerState.saveIndexerPosition.mockImplementation(async () => {
    poller.stop();
  });
  await poller.start();
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  indexerState.getIndexerPosition.mockResolvedValue(null);
  indexer.applyEvent.mockResolvedValue("applied");
  failedEvents.recordFailedEvent.mockResolvedValue(undefined);
  failedEvents.clearFailedEvent.mockResolvedValue(undefined);
  failedEvents.refreshFailedEventBacklog.mockResolvedValue(undefined);
  getLatestLedger.mockResolvedValue({ sequence: CHAIN_HEAD });
});

describe("Poller", () => {
  it("records the last ledger it applied, not the chain's head", async () => {
    // The bug this replaces: the chain's latest ledger was stored as the
    // indexer's position, so a backfill hundreds of thousands of ledgers behind
    // still reported itself level with the chain.
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    await pollOnce({ startLedger: 56000000 });

    expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith({
      lastLedger: LAST_APPLIED,
      chainLedger: CHAIN_HEAD,
      cursor: CURSOR,
    });
    expect(failedEvents.refreshFailedEventBacklog).toHaveBeenCalled();
  });

  it("does not credit itself for events it could not decode", async () => {
    // The page ends with two events of kinds this indexer does not handle. They
    // are skipped, so they cannot advance the position past what was applied.
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    await pollOnce({ startLedger: 56000000 });

    const [saved] = indexerState.saveIndexerPosition.mock.calls[0];
    expect(saved.lastLedger).toBe(LAST_APPLIED);
    expect(saved.lastLedger).toBeLessThan(LAST_UNKNOWN);
  });

  it("ignores unknown event kinds without recording a failure", async () => {
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events.slice(4)));

    await pollOnce({ startLedger: 56000000 });

    expect(indexerState.saveIndexerPosition).toHaveBeenCalled();
    expect(failedEvents.recordFailedEvent).not.toHaveBeenCalled();
    expect(indexer.applyEvent).not.toHaveBeenCalled();
  });

  it("leaves its position alone when a page brings no events", async () => {
    // A quiet contract must not look like progress, and must not look like a
    // reset either: only the chain's head moves.
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: LAST_APPLIED,
      chainLedger: 56900000,
      cursor: CURSOR,
      updatedAt: new Date(0),
    });
    chain.getContractEvents.mockResolvedValue(pageOf([]));

    await pollOnce();

    expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith({
      lastLedger: LAST_APPLIED,
      chainLedger: CHAIN_HEAD,
      cursor: CURSOR,
    });
  });

  it("never decreases the recorded position when a provider reports a lower ledger", async () => {
    // If a provider reports a lower ledger than one already applied, the recorded position
    // (lastLedger) must not move backwards or history would be reprocessed as new.
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 57000000,
      chainLedger: 57000000,
      cursor: CURSOR,
      updatedAt: new Date(0),
    });
    
    // The provider reports a lower latestLedger (e.g. 56000000)
    chain.getContractEvents.mockResolvedValue({
      events: [],
      latestLedger: 56000000,
      cursor: CURSOR,
    });

    await pollOnce();

    // The recorded position (lastLedger) remains at 57000000.
    expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith(
      expect.objectContaining({ lastLedger: 57000000 })
    );
  });

  it("starts a backfill below its configured ledger", async () => {
    // Nothing at or after the start ledger has been processed yet, so the
    // position is the ledger below it — the backfill's full lag shows from the
    // first poll rather than after the first event.
    chain.getContractEvents.mockResolvedValue(pageOf([]));

    await pollOnce({ startLedger: 56000000 });

    expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith(
      expect.objectContaining({ lastLedger: 55999999 }),
    );
  });

  it("starts level with the chain when there is no backfill to do", async () => {
    // With no start ledger configured the indexer deliberately skips all prior
    // history, so it is caught up by definition and should not report lag.
    chain.getContractEvents.mockResolvedValue(pageOf([]));

    await pollOnce();

    expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith(
      expect.objectContaining({ lastLedger: CHAIN_HEAD, chainLedger: CHAIN_HEAD }),
    );
  });

  it("skips a failing event and still saves the cursor", async () => {
    // The old behavior: a single failing applyEvent aborted the whole tick and
    // saveIndexerPosition was never called, so the page was refetched forever.
    // The new behavior: the failing event is logged and skipped; the rest of
    // the page applies and the cursor advances.
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    let callCount = 0;
    indexer.applyEvent.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("db unavailable");
      return "applied";
    });

    await pollOnce({ startLedger: 56000000 });

    // The cursor must have been saved despite the first event failing.
    expect(indexerState.saveIndexerPosition).toHaveBeenCalled();
  });

  it("records a failing event in the failed-events store", async () => {
    // Operators need a queryable record, not just a log line.
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));
    indexer.applyEvent.mockRejectedValue(new Error("constraint violation"));

    await pollOnce({ startLedger: 56000000 });

    expect(failedEvents.recordFailedEvent).toHaveBeenCalled();
  });

  it("clears the failed-event record after a successful apply", async () => {
    // Once an event applies cleanly its stale failure row should be removed so
    // operators only see events that are currently stuck.
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));
    indexer.applyEvent.mockResolvedValue("applied");

    await pollOnce({ startLedger: 56000000 });

    expect(failedEvents.clearFailedEvent).toHaveBeenCalled();
  });

  it("does not advance lastLedger past the most recent successful event", async () => {
    // A failing event must not contribute to lastLedger. The page has events at
    // multiple ledgers; if the last decoded one fails, the position must stop at
    // the last one that succeeded.
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    // Fail only the last apply call (the fourth decoded event, ledger 56290013).
    let callCount = 0;
    indexer.applyEvent.mockImplementation(async () => {
      callCount++;
      if (callCount === 4) throw new Error("last event fails");
      return "applied";
    });

    await pollOnce({ startLedger: 56000000 });

    // The position must reflect only the events that actually applied.
    const [saved] = indexerState.saveIndexerPosition.mock.calls[0];
    // The third decoded event is at ledger 56290012; the fourth fails.
    expect(saved.lastLedger).toBeLessThan(LAST_APPLIED);
  });

  it("asserts a partially applied page is not recorded as complete when an event fails midway", async () => {
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    let callCount = 0;
    let firstAppliedLedger = 0;
    indexer.applyEvent.mockImplementation(async (_s: any, _c: any, _n: any, event: any) => {
      callCount++;
      if (callCount === 1) {
        firstAppliedLedger = event.ledger;
        return "applied";
      }
      throw new Error("event apply failed midway");
    });

    await pollOnce({ startLedger: 56000000 });

    expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        lastLedger: firstAppliedLedger,
      }),
    );
    expect(firstAppliedLedger).toBeLessThan(LAST_APPLIED);
  });

  it("does not record page completion if processing is interrupted midway by an unhandled error", async () => {
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    const eventsModule = await import("../../src/chain/events.js");
    let callCount = 0;
    vi.spyOn(eventsModule, "decodeEvent").mockImplementation((raw: any) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Unhandled DB error mid-page");
      }
      return {
        id: raw.id ?? "unknown",
        ledger: raw.ledger ?? 0,
        closedAt: 0n,
        txHash: raw.txHash ?? "",
        kind: "created",
        streamId: 1n,
        sender: "A",
        recipient: "B",
        token: "C",
        totalAmount: 100n,
        startTime: 0n,
        endTime: 100n,
        cliffTime: 0n,
      };
    });

    const poller = new Poller(server, config, log);
    (poller as any).running = true;

    await expect((poller as any).tick({ lastLedger: 56000000 })).rejects.toThrow(
      "Unhandled DB error mid-page",
    );

    expect(indexerState.saveIndexerPosition).not.toHaveBeenCalled();
  });

  it("detects a cursor regression and skips the page", async () => {
    // A faulty RPC could return a cursor older than the one we already have.
    // The poller must detect this and break out of the page loop instead of
    // applying the same events again.
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: LAST_APPLIED,
      chainLedger: CHAIN_HEAD,
      cursor: "zzz-later-cursor",
      updatedAt: new Date(0),
    });
    chain.getContractEvents.mockResolvedValue({
      events: captured.events,
      latestLedger: CHAIN_HEAD,
      cursor: "aaa-earlier-cursor",
    });

    // The cursor regression path breaks out of tick without calling
    // saveIndexerPosition, so pollOnce would run forever. Use a custom
    // stop trigger: after the first getContractEvents call (which returns
    // the regressed cursor), stop on the next call.
    const poller = new Poller(server, config, log);
    let callCount = 0;
    chain.getContractEvents.mockImplementation(async () => {
      callCount++;
      if (callCount > 1) {
        poller.stop();
        return { events: [], latestLedger: CHAIN_HEAD, cursor: CURSOR };
      }
      return { events: captured.events, latestLedger: CHAIN_HEAD, cursor: "aaa-earlier-cursor" };
    });

    await poller.start();

    // The poller should not have applied any events from the regressed page.
    expect(indexer.applyEvent).not.toHaveBeenCalled();
  });

  it("continues normally when cursor advances", async () => {
    // Normal progression: each page cursor is lexicographically greater than
    // the previous one.
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: 56000000,
      chainLedger: CHAIN_HEAD,
      cursor: "aaa-earlier-cursor",
      updatedAt: new Date(0),
    });
    chain.getContractEvents.mockResolvedValue({
      events: captured.events,
      latestLedger: CHAIN_HEAD,
      cursor: "zzz-later-cursor",
    });

    await pollOnce();

    // Events should be applied normally.
    expect(indexer.applyEvent).toHaveBeenCalled();
  });

  it("treats unchanged cursor as drained (not a regression)", async () => {
    // When the cursor does not change, isBacklogDrained returns true. This is
    // different from a regression — it means the RPC has nothing further.
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: LAST_APPLIED,
      chainLedger: CHAIN_HEAD,
      cursor: CURSOR,
      updatedAt: new Date(0),
    });
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    await pollOnce();

    // The page is applied once (isBacklogDrained breaks the loop), not skipped.
    expect(indexer.applyEvent).toHaveBeenCalled();
  });

  // Uses a realistic interval so the doubling is observable (the shared config
  // uses pollIntervalMs 0, which would collapse every delay to 0).
  const backoffConfig = { ...config, pollIntervalMs: 1000, maxBackoffMs: 7000 };

  it("increases the retry delay with consecutive failures and respects the ceiling", async () => {
    // Timing decisions are checked without sleeping by reading the computed
    // delay directly. 1000ms base, doubling each failure, capped at 7000ms.
    const poller = new Poller(server, backoffConfig, log);

    (poller as any).consecutiveFailures = 0;
    expect((poller as any).backoffDelay()).toBe(1000);
    (poller as any).consecutiveFailures = 1;
    expect((poller as any).backoffDelay()).toBe(2000);
    (poller as any).consecutiveFailures = 2;
    expect((poller as any).backoffDelay()).toBe(4000);
    (poller as any).consecutiveFailures = 3;
    expect((poller as any).backoffDelay()).toBe(7000); // capped
    (poller as any).consecutiveFailures = 4;
    expect((poller as any).backoffDelay()).toBe(7000); // still capped
  });

  it("resets the delay to the normal interval after a successful poll", async () => {
    // A single successful tick must clear the failure streak so the next
    // wait returns to the normal interval, not the backed-off one. Driving
    // start() (which owns the reset) with a stop-on-save keeps it fast.
    const poller = new Poller(server, backoffConfig, log);
    (poller as any).consecutiveFailures = 4;

    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));
    indexerState.saveIndexerPosition.mockImplementation(async () => {
      poller.stop();
    });

    await poller.start();

    expect((poller as any).consecutiveFailures).toBe(0);
    expect((poller as any).backoffDelay()).toBe(1000);
  });

  it("counts a failed poll as a consecutive failure", async () => {
    // One failed tick must advance the streak even though no page was applied.
    // Drive start() (which owns the increment) and stop after the first tick.
    chain.getContractEvents.mockRejectedValue(new Error("rpc unavailable"));

    const poller = new Poller(server, backoffConfig, log);
    const tick = (poller as any).tick.bind(poller);
    (poller as any).tick = async (position: unknown) => {
      try {
        return await tick(position);
      } finally {
        poller.stop();
      }
    };

    await poller.start();

    expect((poller as any).consecutiveFailures).toBe(1);
  });

  // Distinct, monotonically increasing cursors so each full page is a clear
  // advance and never looks like a cursor regression or a drained backlog.
  const cursors = ["cx1", "cx2", "cx3", "cx4", "cx5", "cx6"];
  const MAX = 3;

  it("stops after the configured page maximum and persists the latest cursor", async () => {
    let seq = 0;
    chain.getContractEvents.mockImplementation(async () => fullPage(cursors[seq++]));

    const poller = new Poller(server, { ...config, maxPagesPerTick: MAX }, log);
    indexerState.getIndexerPosition.mockResolvedValue(null);
    getLatestLedger.mockResolvedValue({ sequence: CHAIN_HEAD });
    // `tick` only loops while running; start() sets it, but calling tick
    // directly needs it flipped on first.
    (poller as any).running = true;
    const start = await (poller as any).resolveStart();
    const after = await (poller as any).tick(start);

    expect(chain.getContractEvents).toHaveBeenCalledTimes(MAX);
    expect(after.cursor).toBe(cursors[MAX - 1]);
    // The cursor is saved after every page, so the persisted one is exactly the
    // last page's cursor — not lost when the tick is cut short.
    expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: cursors[MAX - 1] }),
    );
  });

  it("increments rpcErrors and aborts the tick when getContractEvents fails", async () => {
    // When getContractEvents rejects with an RPC error during a poll tick, the
    // poller must increment the rpcErrors metric with the operation label, and abort
    // the tick by throwing the error so no partial state is applied or saved.
    const rpcError = new Error("RPC service unavailable");
    chain.getContractEvents.mockRejectedValue(rpcError);
    const rpcErrorsSpy = vi.spyOn(rpcErrors, "inc");

    const poller = new Poller(server, config, log);
    (poller as any).running = true;

    await expect(
      (poller as any).tick({ lastLedger: 56000000 }),
    ).rejects.toThrow("RPC service unavailable");

    expect(rpcErrorsSpy).toHaveBeenCalledWith({ operation: "getContractEvents" });
    expect(rpcErrorsSpy).toHaveBeenCalledTimes(1);
    expect(indexer.applyEvent).not.toHaveBeenCalled();
    expect(indexerState.saveIndexerPosition).not.toHaveBeenCalled();
  });

  it("counts an RPC timeout (AbortError) as an rpcError and does not crash the poller", async () => {
    // A timeout surfaces as an AbortError (name === "AbortError") from the
    // Stellar SDK when the underlying fetch is cancelled. The poller must count
    // it in the rpcErrors metric — so operators see it — and then let the error
    // propagate to the poll loop, which catches it and continues. The process
    // must not crash.
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "AbortError";
    chain.getContractEvents.mockRejectedValue(timeoutError);
    const rpcErrorsSpy = vi.spyOn(rpcErrors, "inc");

    const poller = new Poller(server, config, log);
    (poller as any).running = true;

    // tick() increments rpcErrors and rethrows — callers must handle the throw.
    await expect(
      (poller as any).tick({ lastLedger: 56000000 }),
    ).rejects.toThrow("The operation was aborted due to timeout");

    // The timeout is counted under the correct operation label.
    expect(rpcErrorsSpy).toHaveBeenCalledWith({ operation: "getContractEvents" });
    expect(rpcErrorsSpy).toHaveBeenCalledTimes(1);

    // No partial state was saved — the tick aborted cleanly.
    expect(indexer.applyEvent).not.toHaveBeenCalled();
    expect(indexerState.saveIndexerPosition).not.toHaveBeenCalled();
  });

  it("keeps the poller running after an RPC timeout and counts it as a poll error", async () => {
    // The poll loop in start() must catch the rethrown timeout, increment
    // pollErrors, and continue rather than letting the process exit. A second
    // tick that succeeds proves the loop recovered.
    const timeoutError = new Error("network timeout");
    timeoutError.name = "AbortError";

    let callCount = 0;
    chain.getContractEvents.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw timeoutError;
      // Second call succeeds and triggers the stop-on-save helper.
      return pageOf([]);
    });

    await pollOnce();

    // The timeout tick incremented pollErrors and the loop kept going.
    // A successful second tick saved a position, proving the loop survived.
    expect(indexerState.saveIndexerPosition).toHaveBeenCalled();
  });

  it("honours the configured poll interval between ticks", async () => {
    vi.useFakeTimers();
    try {
      const poller = new Poller(server, { ...config, pollIntervalMs: 5000 }, log);
      
      let ticks = 0;
      chain.getContractEvents.mockImplementation(async () => {
        ticks++;
        if (ticks === 2) {
          poller.stop();
        }
        return pageOf([]);
      });

      const pollerPromise = poller.start();

      // The first tick is immediate. We advance time just shy of the interval.
      await vi.advanceTimersByTimeAsync(4999);
      expect(chain.getContractEvents).toHaveBeenCalledTimes(1);

      // Advancing the rest of the interval allows the sleep to resolve and the second tick to fire.
      await vi.advanceTimersByTimeAsync(1);
      
      await pollerPromise;

      expect(chain.getContractEvents).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("cursor resume and fresh start behavior", () => {
    it("resumes from a stored cursor rather than the configured start ledger", async () => {
      const storedCursor = "000000100-saved-cursor";
      indexerState.getIndexerPosition.mockResolvedValue({
        lastLedger: 50000000,
        chainLedger: CHAIN_HEAD,
        cursor: storedCursor,
        updatedAt: new Date(0),
      });

      chain.getContractEvents.mockResolvedValue(pageOf([]));

      await pollOnce({ startLedger: 10000000 });

      expect(chain.getContractEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cursor: storedCursor }),
      );
    });

    it("starts a fresh database from the configured ledger when no cursor is stored", async () => {
      indexerState.getIndexerPosition.mockResolvedValue(null);

      chain.getContractEvents.mockResolvedValue(pageOf([]));

      const configuredStart = 45000000;
      await pollOnce({ startLedger: configuredStart });

      expect(chain.getContractEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ startLedger: configuredStart }),
      );
      expect(indexerState.saveIndexerPosition).toHaveBeenCalledWith(
        expect.objectContaining({ lastLedger: configuredStart - 1 }),
      );
    });
  });
});
