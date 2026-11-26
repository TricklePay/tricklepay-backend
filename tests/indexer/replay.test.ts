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
  refreshFailedEventBacklog: vi.fn(),
  recordFailedEvent: vi.fn(),
  getFailedEventById: vi.fn(),
}));

const indexer = vi.hoisted(() => ({ applyEvent: vi.fn() }));

const database = vi.hoisted(() => ({
  transaction: vi.fn(),
  disconnect: vi.fn(),
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
  prisma: {
    $transaction: database.transaction,
    $disconnect: database.disconnect,
  },
}));

const { replayFailedEvents, main: replayMain } = await import("../../src/indexer/replay.js");

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
  failedEvents.refreshFailedEventBacklog.mockResolvedValue(undefined);
  failedEvents.recordFailedEvent.mockResolvedValue(undefined);
  failedEvents.getFailedEventById.mockResolvedValue(null);
  database.disconnect.mockResolvedValue(undefined);
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
    expect(failedEvents.refreshFailedEventBacklog).toHaveBeenCalled();
  });

  it("replays a recorded failed event and applies it to stream state", async () => {
    // The recorded failure predates the event applying cleanly; replay must
    // find the event on chain, apply it for real, and report success.
    const appliedAmounts: bigint[] = [];
    indexer.applyEvent.mockImplementation(async (_server, _contract, _passphrase, event) => {
      appliedAmounts.push(event.amount);
      return "applied";
    });

    const result = await replayFailedEvents(
      {} as rpc.Server,
      CONTRACT_ID,
      PASSPHRASE,
    );

    expect(appliedAmounts).toHaveLength(1);
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0, dryRun: false });
    expect(failedEvents.clearFailedEvent).toHaveBeenCalledWith(
      { eventId: WITHDRAWAL_EVENT_ID },
      database.tx,
    );
    expect(failedEvents.recordFailedEvent).not.toHaveBeenCalled();
  });

  it("clears the failure record after a successful replay, inside the apply transaction", async () => {
    indexer.applyEvent.mockResolvedValue("applied");

    await replayFailedEvents({} as rpc.Server, CONTRACT_ID, PASSPHRASE);

    // The clear happens with the same transaction client applyEvent used, so
    // a crash can never leave the event applied but still marked failed.
    expect(failedEvents.clearFailedEvent).toHaveBeenCalledTimes(1);
    expect(failedEvents.clearFailedEvent).toHaveBeenCalledWith(
      { eventId: WITHDRAWAL_EVENT_ID },
      database.tx,
    );
    expect(failedEvents.recordFailedEvent).not.toHaveBeenCalled();
  });

  it("keeps the failure record when the event can no longer be found on chain", async () => {
    chain.getContractEvents.mockResolvedValue({
      events: [],
      latestLedger: 56999999,
      cursor: "",
    });

    const result = await replayFailedEvents(
      {} as rpc.Server,
      CONTRACT_ID,
      PASSPHRASE,
    );

    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1, dryRun: false });
    expect(indexer.applyEvent).not.toHaveBeenCalled();
    expect(failedEvents.clearFailedEvent).not.toHaveBeenCalled();
    expect(failedEvents.recordFailedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: WITHDRAWAL_EVENT_ID,
        error: expect.stringContaining("not found on chain"),
      }),
    );
  });

  it("continues past unreplayable rows and reaches a later replayable failure", async () => {
    failedEvents.listFailedEvents.mockResolvedValue([
      { eventId: "old-1", kind: "unknown", streamId: null, ledger: 1, failureCount: 1 },
      { eventId: "old-2", kind: "unknown", streamId: null, ledger: 2, failureCount: 1 },
      { eventId: WITHDRAWAL_EVENT_ID, kind: "withdrawn", streamId: "42", ledger: 3, failureCount: 1 },
    ]);
    indexer.applyEvent.mockResolvedValue("applied");

    const result = await replayFailedEvents(
      {} as rpc.Server,
      CONTRACT_ID,
      PASSPHRASE,
      { limit: 2 },
    );

    expect(result).toEqual({ attempted: 3, succeeded: 1, failed: 2, dryRun: false });
    expect(failedEvents.clearFailedEvent).toHaveBeenCalledWith(
      { eventId: WITHDRAWAL_EVENT_ID },
      database.tx,
    );
  });

  it("dry-run reports what would happen without touching the database", async () => {
    indexer.applyEvent.mockResolvedValue("applied");

    const result = await replayFailedEvents(
      {} as rpc.Server,
      CONTRACT_ID,
      PASSPHRASE,
      { dryRun: true },
    );

    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0, dryRun: true });
    expect(indexer.applyEvent).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(failedEvents.clearFailedEvent).not.toHaveBeenCalled();
    expect(failedEvents.recordFailedEvent).not.toHaveBeenCalled();
  });

  it("suppresses informational logger messages when silent is true", async () => {
    indexer.applyEvent.mockResolvedValue("applied");

    const result = await replayFailedEvents(
      {} as rpc.Server,
      CONTRACT_ID,
      PASSPHRASE,
      { dryRun: true, silent: true },
    );

    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0, dryRun: true });
  });

  describe("replay CLI streams", () => {
    it("routes json results to stdout and leaves stderr empty in bulk replay mode", async () => {
      indexer.applyEvent.mockResolvedValue("applied");
      const origArgv = process.argv;
      const origExitCode = process.exitCode;
      const origContract = process.env.STREAM_CONTRACT_ID;
      const origDb = process.env.DATABASE_URL;
      process.env.STREAM_CONTRACT_ID = CONTRACT_ID;
      process.env.DATABASE_URL = "postgresql://ci:ci@localhost:5432/tricklepay";
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        process.argv = ["node", "replay.js", "--dry-run", "--json"];
        process.exitCode = undefined;

        await replayMain();

        expect(process.exitCode).toBeUndefined();
        expect(stderrSpy).not.toHaveBeenCalled();
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(String(stdoutSpy.mock.calls[0][0]));
        expect(parsed).toEqual({
          attempted: 1,
          succeeded: 1,
          failed: 0,
          dryRun: true,
        });
      } finally {
        process.argv = origArgv;
        process.exitCode = origExitCode;
        process.env.STREAM_CONTRACT_ID = origContract;
        process.env.DATABASE_URL = origDb;
      }
    });

    it("routes single event not-found diagnostic error to stderr in text mode", async () => {
      failedEvents.listFailedEvents.mockResolvedValue([]);
      const origArgv = process.argv;
      const origExitCode = process.exitCode;
      const origContract = process.env.STREAM_CONTRACT_ID;
      const origDb = process.env.DATABASE_URL;
      process.env.STREAM_CONTRACT_ID = CONTRACT_ID;
      process.env.DATABASE_URL = "postgresql://ci:ci@localhost:5432/tricklepay";
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        process.argv = ["node", "replay.js", "--event-id=0000000000000000000-0000000000"];
        process.exitCode = undefined;

        await replayMain();

        expect(process.exitCode).toBe(1);
        expect(stdoutSpy).not.toHaveBeenCalled();
        expect(stderrSpy).toHaveBeenCalled();
        const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(errOutput).toContain("not found in failed events table");
      } finally {
        process.argv = origArgv;
        process.exitCode = origExitCode;
        process.env.STREAM_CONTRACT_ID = origContract;
        process.env.DATABASE_URL = origDb;
      }
    });
  });
});
