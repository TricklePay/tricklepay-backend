import { rpc } from "@stellar/stellar-sdk";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import capture from "../fixtures/get-events.json" with { type: "json" };

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
  getIndexerCursor: vi.fn(),
  saveIndexerCursor: vi.fn(),
}));

const indexer = vi.hoisted(() => ({ applyEvent: vi.fn() }));

// The real module is kept underneath so `EVENT_PAGE_LIMIT` is the number the
// poller actually uses; a page built here is full because it is that long, not
// because the test and the source happen to agree on a literal.
vi.mock("../../src/chain/rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/rpc.js")>()),
  ...chain,
}));
vi.mock("../../src/repositories/indexer-state.js", () => indexerState);
vi.mock("../../src/indexer/apply.js", () => indexer);

const { Poller, isBacklogDrained } = await import("../../src/indexer/poller.js");
const { EVENT_PAGE_LIMIT } = await import("../../src/chain/rpc.js");

const captured = rpc.parseRawEvents(capture.result as unknown as rpc.Api.RawGetEventsResponse);

// The captured page holds six events, four of which this indexer understands.
const CAPTURED_APPLIED = 4;
const CHAIN_HEAD = 56999999;

const config: Config = {
  port: 3000,
  host: "0.0.0.0",
  databaseUrl: "postgresql://localhost/test",
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW",
  // The loop sleeps between ticks; zero keeps the tests instant without
  // changing which pages a tick fetches.
  pollIntervalMs: 0,
  startLedger: 0,
};

const log = pino({ level: "silent" });
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
  indexerState.getIndexerCursor.mockResolvedValue(null);
  indexer.applyEvent.mockResolvedValue(undefined);
  // With no saved cursor and no configured backfill, the poller asks the chain
  // where to start.
  server.getLatestLedger.mockResolvedValue({ sequence: CHAIN_HEAD });
});

describe("isBacklogDrained", () => {
  it("treats a page the RPC could not fill as the end of the backlog", () => {
    expect(isBacklogDrained(shortPage("cursor-2"), "cursor-1")).toBe(true);
  });

  it("treats an empty page as the end of the backlog", () => {
    expect(isBacklogDrained({ events: [], latestLedger: CHAIN_HEAD, cursor: "c" }, "c")).toBe(true);
  });

  it("treats a full page as having more behind it", () => {
    expect(isBacklogDrained(fullPage("cursor-2"), "cursor-1")).toBe(false);
  });

  it("stops on a full page whose cursor has not moved", () => {
    // Fetching this page again returns the same events, so continuing would
    // spin on the RPC for as long as it keeps answering.
    expect(isBacklogDrained(fullPage("cursor-1"), "cursor-1")).toBe(true);
  });
});

describe("Poller", () => {
  it("keeps fetching within one tick while pages come back full", async () => {
    // The point of the exercise: three pages of backlog are drained in a single
    // tick, so throughput is bounded by the network rather than by the poll
    // interval, which under the old behaviour would have spread these across
    // three sleeps.
    const p = poller({ pollIntervalMs: 60_000 });
    chain.getContractEvents
      .mockResolvedValueOnce(fullPage("cursor-1"))
      .mockResolvedValueOnce(fullPage("cursor-2"))
      .mockImplementationOnce(async () => {
        p.stop();
        return shortPage("cursor-3");
      });

    await p.start();

    expect(chain.getContractEvents).toHaveBeenCalledTimes(3);
    expect(indexer.applyEvent).toHaveBeenCalledTimes(EVENT_PAGE_LIMIT * 2 + CAPTURED_APPLIED);
  });

  it("carries the cursor from one page to the next", async () => {
    const p = poller();
    chain.getContractEvents.mockResolvedValueOnce(fullPage("cursor-1")).mockImplementationOnce(
      async () => {
        p.stop();
        return shortPage("cursor-2");
      },
    );

    await p.start();

    expect(chain.getContractEvents).toHaveBeenNthCalledWith(1, server, config.contractId, {
      startLedger: CHAIN_HEAD,
    });
    expect(chain.getContractEvents).toHaveBeenNthCalledWith(2, server, config.contractId, {
      cursor: "cursor-1",
    });
  });

  it("saves the cursor after every page, not only the last", async () => {
    // A backfill interrupted part way through has to resume from the page it
    // reached, not repeat the whole tick.
    const p = poller();
    chain.getContractEvents
      .mockResolvedValueOnce(fullPage("cursor-1"))
      .mockResolvedValueOnce(fullPage("cursor-2"))
      .mockImplementationOnce(async () => {
        p.stop();
        return shortPage("cursor-3");
      });

    await p.start();

    expect(indexerState.saveIndexerCursor.mock.calls.map(([, cursor]) => cursor)).toEqual([
      "cursor-1",
      "cursor-2",
      "cursor-3",
    ]);
  });

  it("sleeps once a page comes back short", async () => {
    // A caught-up indexer takes one page per tick, so the poll interval still
    // governs how often it looks at the chain.
    const p = poller();
    let fetches = 0;
    chain.getContractEvents.mockImplementation(async () => {
      fetches += 1;
      if (fetches === 2) p.stop();
      return shortPage(`cursor-${fetches}`);
    });

    await p.start();

    expect(fetches).toBe(2);
  });

  it("stops between pages rather than draining the whole backlog first", async () => {
    // Every page is full, so the drain would continue indefinitely; a stop has
    // to break it at the next page boundary, with the page in hand finished.
    const p = poller();
    let fetches = 0;
    chain.getContractEvents.mockImplementation(async () => {
      fetches += 1;
      if (fetches === 2) p.stop();
      return fullPage(`cursor-${fetches}`);
    });

    await p.start();

    expect(fetches).toBe(2);
    expect(indexerState.saveIndexerCursor).toHaveBeenCalledTimes(2);
  });
});
