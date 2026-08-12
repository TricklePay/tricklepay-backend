import { rpc } from "@stellar/stellar-sdk";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import capture from "../fixtures/get-events.json" with { type: "json" };

// What the poller records about itself. The RPC, the database and the apply
// step are all stubbed, so what is under test is the bookkeeping: which ledger
// the poller claims to have reached after a page, and whether that figure comes
// from the events it applied or from the chain's head.
//
// The captured page is fed in as the RPC would return it, so the ledgers being
// asserted are decoded from real event XDR rather than made up here.
// How the poller paces itself against a backlog. The RPC, the database and the
// apply step are stubbed, so what these tests measure is the fetch pattern: how
// many pages one tick pulls before it returns to the loop and sleeps.
//
// Pages are built from the captured RPC response, so the events flowing through
// are decoded from real XDR rather than stood in for.

const chain = vi.hoisted(() => ({
  getContractEvents: vi.fn(),
  createRpcServer: vi.fn(),
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
  // The loop sleeps between ticks; zero keeps the tests instant without
  // changing which pages a tick fetches.
  pollIntervalMs: 0,
  startLedger: 0,
};

const log = pino({ level: "silent" });

const getLatestLedger = vi.fn();
const server = { getLatestLedger } as unknown as rpc.Server;

function pageOf(events: rpc.Api.EventResponse[], latestLedger = CHAIN_HEAD) {
  return { events, latestLedger, cursor: CURSOR };
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
function pageOf(events: rpc.Api.EventResponse[], latestLedger = CHAIN_HEAD) {
  return { events, latestLedger, cursor: CURSOR };
const server = { getLatestLedger: vi.fn() };

function poller(overrides: Partial<Config> = {}) {
  return new Poller(server as unknown as rpc.Server, { ...config, ...overrides }, log);
}

// A page the RPC could not fill: the backlog is drained.
function shortPage(cursor: string) {
  return { events: captured.events, latestLedger: CHAIN_HEAD, cursor };
}

// A page filled to the limit: there is more behind it.
function fullPage(cursor: string) {
  const events = Array.from({ length: EVENT_PAGE_LIMIT }, () => captured.events[0]);
  return { events, latestLedger: CHAIN_HEAD, cursor };
}

beforeEach(() => {
  vi.resetAllMocks();
  indexerState.getIndexerPosition.mockResolvedValue(null);
  indexer.applyEvent.mockResolvedValue(undefined);
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
  it("saves nothing when applying an event fails", async () => {
    // A half-applied page must not be recorded as reached; the tick aborts, the
    // cursor stays where it was, and the page is read again next time.
    chain.getContractEvents.mockResolvedValue(pageOf(page.events));

    const poller = new Poller(server, { ...config, startLedger: 56000000 }, log);
    indexer.applyEvent.mockImplementation(async () => {
      poller.stop();
      throw new Error("database unavailable");
    });

    await poller.start();

    expect(indexerState.saveIndexerPosition).not.toHaveBeenCalled();
  });
});
