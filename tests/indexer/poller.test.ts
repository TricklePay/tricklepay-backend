import { rpc } from "@stellar/stellar-sdk";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { renderMetrics } from "../../src/metrics.js";
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
  vi.resetAllMocks();
  indexerState.getIndexerPosition.mockResolvedValue(null);
  indexer.applyEvent.mockResolvedValue("applied");
  failedEvents.recordFailedEvent.mockResolvedValue(undefined);
  failedEvents.clearFailedEvent.mockResolvedValue(undefined);
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

  it("records a heartbeat and success counter on a successful tick", async () => {
    // Operators distinguish a quiet chain (still polling) from a stalled poller
    // (no successful tick) via these two series. A tick that returns must bump
    // both: the count by one, and the timestamp to roughly now.
    chain.getContractEvents.mockResolvedValue(pageOf(captured.events));

    const beforeSuccess = metricValue("tricklepay_indexer_poll_success_total");
    const beforeTs = metricValue("tricklepay_indexer_poll_last_success_timestamp_seconds");

    const poller = new Poller(server, { ...config }, log);
    (poller as any).running = true;
    const start = await (poller as any).resolveStart();
    await (poller as any).tick(start);

    expect(metricValue("tricklepay_indexer_poll_success_total")).toBe(beforeSuccess + 1);
    const afterTs = metricValue("tricklepay_indexer_poll_last_success_timestamp_seconds");
    const nowSec = Math.floor(Date.now() / 1000);
    expect(afterTs).toBeGreaterThanOrEqual(beforeTs);
    expect(afterTs).toBeGreaterThanOrEqual(nowSec - 2);
    expect(afterTs).toBeLessThanOrEqual(nowSec + 1);
  });

  it("does not emit a false heartbeat when a tick fails", async () => {
    // A failed iteration must not advance either series — otherwise an alert
    // would think the poller is healthy when it is stalled.
    chain.getContractEvents.mockRejectedValue(new Error("rpc unavailable"));

    const beforeSuccess = metricValue("tricklepay_indexer_poll_success_total");
    const beforeTs = metricValue("tricklepay_indexer_poll_last_success_timestamp_seconds");

    const poller = new Poller(server, { ...config }, log);
    (poller as any).running = true;
    const start = await (poller as any).resolveStart();
    await expect((poller as any).tick(start)).rejects.toThrow();

    expect(metricValue("tricklepay_indexer_poll_success_total")).toBe(beforeSuccess);
    expect(metricValue("tricklepay_indexer_poll_last_success_timestamp_seconds")).toBe(beforeTs);
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

  it("resumes from the persisted cursor on the next tick without replaying", async () => {
    let seq = 0;
    chain.getContractEvents.mockImplementation(async () => fullPage(cursors[seq++]));

    const poller = new Poller(server, { ...config, maxPagesPerTick: MAX }, log);
    indexerState.getIndexerPosition.mockResolvedValue(null);
    getLatestLedger.mockResolvedValue({ sequence: CHAIN_HEAD });
    (poller as any).running = true;

    const start1 = await (poller as any).resolveStart();
    const after1 = await (poller as any).tick(start1);
    const persistedCursor = after1.cursor;
    expect(persistedCursor).toBe(cursors[MAX - 1]);
    expect(chain.getContractEvents).toHaveBeenCalledTimes(MAX);

    // A second tick must begin from the persisted cursor and fetch the next
    // pages, not re-fetch the ones already applied.
    indexerState.getIndexerPosition.mockResolvedValue({
      lastLedger: CHAIN_HEAD,
      chainLedger: CHAIN_HEAD,
      cursor: persistedCursor,
    });
    const start2 = await (poller as any).resolveStart();
    const after2 = await (poller as any).tick(start2);

    // Every page past the persisted cursor was fetched exactly once: twice the
    // cap, with no replay of the first batch.
    expect(chain.getContractEvents).toHaveBeenCalledTimes(MAX * 2);
    expect(after2.cursor).toBe(cursors[MAX * 2 - 1]);
  });

  it("does not fragment a modest backlog when using the default limit", async () => {
    // A backlog smaller than the default cap should drain in a single tick via
    // the normal "backlog drained" path, not be chopped by the page limit.
    let call = 0;
    chain.getContractEvents.mockImplementation(async () => {
      call += 1;
      if (call < 3) return fullPage(`cx${call}`);
      return { events: [], latestLedger: CHAIN_HEAD, cursor: undefined };
    });

    const poller = new Poller(server, { ...config }, log); // default limit (1000)
    indexerState.getIndexerPosition.mockResolvedValue(null);
    getLatestLedger.mockResolvedValue({ sequence: CHAIN_HEAD });
    (poller as any).running = true;
    const start = await (poller as any).resolveStart();
    await (poller as any).tick(start);

    // 2 full pages + 1 terminal drain — stopped by drain, not the limit.
    expect(chain.getContractEvents).toHaveBeenCalledTimes(3);
  });
});

function metricValue(name: string): number {
  const match = renderMetrics().match(new RegExp(`^${name} (\\S+)$`, "m"));
  return match ? Number(match[1]) : 0;
}
