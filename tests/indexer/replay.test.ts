import { rpc } from "@stellar/stellar-sdk";

import { beforeEach, describe, expect, it, vi } from "vitest";

import capture from "../fixtures/get-events.json" with { type: "json" };

const chain = vi.hoisted(() => ({
  getContractEvents: vi.fn(),
  createRpcServer: vi.fn(),
  EVENT_PAGE_LIMIT: 100,
}));

const failedEvents = vi.hoisted(() => ({
  clearFailedEvent: vi.fn(),
  listFailedEvents: vi.fn(),
  recordFailedEvent: vi.fn(),
}));

const indexer = vi.hoisted(() => ({ applyEvent: vi.fn() }));

const database = vi.hoisted(() => ({
  transaction: vi.fn(),
  tx: {
    indexedEvent: {
      createMany: vi.fn(),
    },
  },
}));

vi.mock("../../src/chain/rpc.js", () => chain);
vi.mock("../../src/repositories/failed-events.js", () => failedEvents);
vi.mock("../../src/indexer/apply.js", () => indexer);
vi.mock("../../src/db.js", () => ({
  prisma: { $transaction: database.transaction },
}));

const { replayFailedEvents } = await import("../../src/indexer/replay.js");

const CONTRACT_ID = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
const PASSPHRASE = "Test SDF Network ; September 2015";
const WITHDRAWAL_EVENT_ID = "0241383411213664256-0000000001";
const captured = rpc.parseRawEvents(capture.result as unknown as rpc.Api.RawGetEventsResponse);

beforeEach(() => {
  vi.resetAllMocks();
  database.transaction.mockImplementation(async (callback) => callback(database.tx));
  failedEvents.listFailedEvents.mockResolvedValue([{
    eventId: WITHDRAWAL_EVENT_ID,
    kind: "withdrawn",
    streamId: "42",
    ledger: 56201455,
    error: "temporary database failure",
    failureCount: 1,
    firstFailedAt: new Date(0),
    lastFailedAt: new Date(0),
  }]);
  failedEvents.clearFailedEvent.mockResolvedValue(undefined);
  failedEvents.recordFailedEvent.mockResolvedValue(undefined);
  chain.getContractEvents.mockResolvedValue({
    events: [captured.events[1]],
    latestLedger: 56999999,
    cursor: "",
  });
});

describe("replayFailedEvents", () => {
  it("does not reapply state or write another audit row for an already applied event", async () => {
    const appliedEventIds = new Set([WITHDRAWAL_EVENT_ID]);
    const state = { withdrawn: 2_500_000n };
    const stateBeforeReplay = { ...state };
    const auditRows = new Set([WITHDRAWAL_EVENT_ID]);

    indexer.applyEvent.mockImplementation(async (_server, _contract, _passphrase, event) => {
      if (appliedEventIds.has(event.id)) return "duplicate";
      appliedEventIds.add(event.id);
      state.withdrawn += event.amount;
      return "applied";
    });

    const result = await replayFailedEvents(
      {} as rpc.Server,
      CONTRACT_ID,
      PASSPHRASE,
    );

    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0, dryRun: false });
    expect(state).toEqual(stateBeforeReplay);
    expect(auditRows).toEqual(new Set([WITHDRAWAL_EVENT_ID]));
    expect(database.tx.indexedEvent.createMany).not.toHaveBeenCalled();
    expect(failedEvents.clearFailedEvent).toHaveBeenCalledWith(
      { eventId: WITHDRAWAL_EVENT_ID },
      database.tx,
    );
  });
});
