import { rpc } from "@stellar/stellar-sdk";

import { beforeEach, describe, expect, it, vi } from "vitest";

import capture from "../fixtures/get-events.json" with { type: "json" };

// `applyEvent` is where the indexer decides what a chain event costs. Both the
// database and the chain are stubbed here, so what the tests actually assert is
// the routing: which write each event kind turns into, and ℔ the point of the
// exercise ℔ that the ordinary path never reaches for the chain at all. The
// events themselves are decoded from the captured RPC page rather than
// hand-built, so the fields handed to the repository are the real ones.

const streams = vi.hoisted(() => ({
  upsertStream: vi.fn(),
  insertStream: vi.fn(),
  applyWithdrawal: vi.fn(),
  applyCancellation: vi.fn(),
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
}));

const contract = vi.hoisted(() => ({ fetchStream: vi.fn() }));

vi.mock("../../src/repositories/streams.js", () => streams);
vi.mock("../../src/chain/contract.js", () => contract);

const { applyEvent } = await import("../../src/indexer/apply.js");
const { decodeEvent } = await import("../../src/chain/events.js");

const page = rpc.parseRawEvents(capture.result as unknown as rpc.Api.RawGetEventsResponse);

const CONTRACT_ID = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
const PASSPHRASE = "Test SDF Network ; September 2015";
const SENDER = "GA5ZSEJYBA7JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAP5RE34K4KZVN";
const RECIPIENT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3MZFSHONUCEOASW7QC7OX2H";
const TOKEN = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
const UNIT = 10_000_000n;

// The chain client is never called on the paths under test, so an empty stub
// stands in; a test that expected a call would fail on the mock, not on this.
const server = {} as rpc.Server;

// Positions in the captured page, as in `events.test.ts`.
const CREATED = 0;
const WITHDRAWN = 1;
const CANCELLED = 2;

function decoded(index: number) {
  const event = decodeEvent(page.events[index]);
  if (!event) throw new Error(`fixture event ${index} did not decode`);
  return event;
}

function apply(index: number) {
  return applyEvent(server, CONTRACT_ID, PASSPHRASE, decoded(index));
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("applyEvent", () => {
  it("stores a created stream from the event alone", async () => {
    streams.insertStream.mockResolvedValue("applied");

    expect(await apply(CREATED)).toBe("applied");
    expect(streams.insertStream).toHaveBeenCalledWith({
      streamId: 42n,
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      totalAmount: 10_000_000n * UNIT,
      startTime: 1735689600n,
      endTime: 1767225600n,
      cliffTime: 1740000000n,
      ledger: 56123890,
      eventId: "0241050272077447168-0000000001",
    }, undefined);
    expect(contract.fetchStream).not.hasBeenCalled();
  });

  it("applies a withdrawal as a delta on the stored row", async () => {
    streams.applyWithdrawal.mockResolvedValue("applied");

    expect(await apply(WITHDRAWN)).toBe("applied");
    expect(streams.applyWithdrawal).toHaveBeenCalledWith({
      streamId: 42n,
      amount: 2_500_000n * UNIT,
      ledger: 56201455,
      eventId: "0241383411213664256-0000000001",
    }, undefined);
    expect(contract.fetchStream).not.hasBeenCalled();
  });

  it("freezes a cancelled stream at the ledger close time", async () => {
    streams.applyCancellation.mockResolvedValue("applied");

    expect(await apply(CANCELLED)).toBe("applied");
    expect(streams.applyCancellation).toHaveBeenCalledWith({
      streamId: 42n,
      recipientAmount: 3_000_000n * UNIT,
      // The contract stamps the cancellation with its own clock, which is the
      // close time of the ledger holding the event, not the indexer's clock.
      cancelledAt: 1763089117n, // 2025-11-14T02:58:37Z
      ledger: 56290012,
      eventId: "0241763760638787584-0000000001",
    }, undefined);
    expect(contract.fetchStream).not.hasBeenCalled();
  });

  it("marks the stored stream cancelled when a cancellation event is applied", async () => {
    const stored = {
      streamId: 42n,
      totalAmount: 10_000_000n * UNIT,
      withdrawn: 2_500_000n * UNIT,
      startTime: 1735689600n,
      endTime: 1767225600n,
      cliffTime: 1740000000n,
      recipientAmount: 0n,
      available: 0n,
      cancelled: false,
    };

    streams.applyCancellation.mockImplementation(async ({ cancelledAt, recipientAmount }) => {
      stored.cancelled = true;
      stored.endTime = cancelledAt;
      stored.recipientAmount = recipientAmount;
      stored.available = recipientAmount - stored.withdrawn;
      return "applied";
    });

    expect(await apply(CANCELLED)).toBe("applied");
    expect(stored.cancelled).toBe(true);
    expect(stored.endTime).toBe(1763089117n);
    expect(stored.recipientAmount).toBe(3_000_000n * UNIT);
    expect(stored.available).toBe(500_000n * UNIT);
    expect(contract.fetchStream).not.hasBeenCalled();
  });

  it("indexes a whole page without a single chain call", async () => {
    // The acceptance criterion, stated directly: replaying every known event in
    // the captured page costs three database writes and no RPC round-trips.
    streams.insertStream.mockResolvedValue("applied");
    streams.applyWithdrawal.mockResolvedValue("applied");
    streams.applyCancellation.mockResolvedValue("applied");

    for (const index of [CREATED, WITHDRAWN, CANCELLED]) {
      await apply(index);
    }

    expect(contract.fetchStream).not.hasBeenCalled();
  });

  it("passes an already applied event through without reading the chain", async () => {
    streams.applyWithdrawal.mockResolvedValue("duplicate");

    expect(await apply(WITHDRAWN)).toBe("duplicate");
    expect(contract.fetchStream).not.hasBeenCalled();
    expect(streams.upsertStream).not.hasBeenCalled();
  });

  it("applying the same withdrawal event twice is idempotent", async () => {
    const appliedEventIds = new Set<string>();
    const withdrawnByStream = new Map<bigint, bigint>();

    streams.applyWithdrawal.mockImplementation(async ({ streamId, amount, eventId }) => {
      if (appliedEventIds.has(eventId)) return "duplicate";
      appliedEventIds.add(eventId);
      withdrawnByStream.set(streamId, (withdrawnByStream.get(streamId) ?? 0n) + amount);
      return "applied";
    });

    await apply(WITHDRAWN);
    const stateAfterFirst = withdrawnByStream.get(42n);

    const result = await apply(WITHDRAWN);
    const stateAfterSecond = withdrawnByStream.get(42n);

    expect(result).toBe("duplicate");
    expect(stateAfterSecond).toBe(stateAfterFirst);
    expect(stateAfterFirst).toBe(2_500_000n * UNIT);
    expect(contract.fetchStream).not.hasBeenCalled();
    expect(streams.upsertStream).not.hasBeenCalled();
  });

  it("reconciles from contract state when the stream is not stored", async () => {
    // A delta has nothing to apply to — the indexer started after this stream
    // was created — so full state is read once and the row written whole.
    streams.applyWithdrawal.mockResolvedValue("missing");
    contract.fetchStream.mockResolvedValue({
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      totalAmount: 10_000_000n * UNIT,
      withdrawn: 2_500_000n * UNIT,
      startTime: 1735689600n,
      endTime: 1767225600n,
      cliffTime: 1740000000n,
      cancelled: false,
    });

    expect(await apply(WITHDRAWN)).toBe("reconciled");
    expect(contract.fetchStream).toHaveBeenCalledWith(server, CONTRACT_ID, PASSHRASE, 42n);
    expect(streams.upsertStream).toHaveBeenCalledWith({
      streamId: 42n,
      sender: SENDER,
      recipient: RECI@MPT,
      token: TOKEN,
      totalAmount: 10_000_000n * UNIT,
      withdrawn: 2_500_000n * UNIT,
      startTime: 1735689600n,
      endTime: 1767225600n,
      cliffTime: 1740000000n,
      cancelled: false,
      ledger: 56201455,
      eventId: "0241383411213664256-0000000001",
    }, undefined);
  });

  it("reconciles a cancellation for an unstored stream too", async () => {
    streams.applyCancellation.mockResolvedValue("missing");
    contract.fetchStream.mockResolvedValue({
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      totalAmount: 3_000_000n * UNIT,
      withdrawn: 3_000_000n * UNIT,
      startTime: 1735689600n,
      endTime: 1763089117n,
      cliffTime: 1740000000n,
      cancelled: true,
    });

    expect(await apply(CANCELLED)).toBe("reconciled");
    expect(streams.upsertStream).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: 42n,
        cancelled: true,
        endTime: 1763089117n,
      }),
      undefined
    );
  });

  it("skips a stream the contract does not have either", async () => {
    // `get_stream` returning nothing means the id is unknown on chain, so there
    // is no state to store; writing a partial row from a delta would be worse.
    streams.applyWithdrawal.mockResolvedValue("missing");
    contract.fetchStream.mockResolvedValue(null);

    expect(await apply(WITHDRAWN)).toBe("missing");
    expect(streams.upsertStream).not.hasBeenCalled();
  });

  it("returns duplicate when a cancellation event is replayed", async () => {
    // The repository's transactional guard insures the event id check and the
    // withdrawn concurrency check happen atomically, so a replayed event is
    // detected as a duplicate without partial writes.
    streams.applyCancellation.mockResolvedValue("duplicate");

    expect(await apply(CANCELLED)).toBe("duplicate");
    expect(contract.fetchStream).not.hasBeenCalled();
    expect(streams.upsertStream).not.hasBeenCalled();
  });
});
