import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "@stellar/stellar-sdk";

// Issue #66 — Contract reconciliation tests.
//
// The missing-stream path calls fetchStream and writes authoritative state.
// These tests mock the Soroban simulation response to verify that:
// 1. A simulated stream maps every contract field to the repository model.
// 2. A missing contract result produces the documented "missing" outcome.
// 3. Ordinary events still avoid the RPC entirely.

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

const page = rpc.parseRawEvents(
  (await import("../fixtures/get-events.json", { with: { type: "json" } })).default.result as unknown as rpc.Api.RawGetEventsResponse,
);

const CONTRACT_ID = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
const PASSPHRASE = "Test SDF Network ; September 2015";
const SENDER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const RECIPIENT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TOKEN = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
const UNIT = 10_000_000n;

const server = {} as rpc.Server;
const WITHDRAWN = 1;

function decoded(index: number) {
  const event = decodeEvent(page.events[index]);
  if (!event) throw new Error(`fixture event ${index} did not decode`);
  return event;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("contract reconciliation (#66)", () => {
  it("maps every contract field to the repository model on successful simulation", async () => {
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

    const result = await applyEvent(server, CONTRACT_ID, PASSPHRASE, decoded(WITHDRAWN));

    expect(result).toBe("reconciled");
    expect(contract.fetchStream).toHaveBeenCalledWith(
      server,
      CONTRACT_ID,
      PASSPHRASE,
      42n,
    );
    expect(streams.upsertStream).toHaveBeenCalledWith({
      streamId: 42n,
      sender: SENDER,
      recipient: RECIPIENT,
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

  it("maps a cancelled stream with frozen endTime", async () => {
    streams.applyCancellation.mockResolvedValue("missing");
    contract.fetchStream.mockResolvedValue({
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      totalAmount: 3_000_000n * UNIT,
      withdrawn: 3_000_000n * UNIT,
      startTime: 1735689600n,
      endTime: 1763089117n, // frozen at cancellation moment
      cliffTime: 1740000000n,
      cancelled: true,
    });

    const result = await applyEvent(server, CONTRACT_ID, PASSPHRASE, decoded(2));

    expect(result).toBe("reconciled");
    expect(streams.upsertStream).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: 42n,
        cancelled: true,
        endTime: 1763089117n,
      }),
      undefined
    );
  });

  it("produces 'missing' when the contract returns null", async () => {
    streams.applyWithdrawal.mockResolvedValue("missing");
    contract.fetchStream.mockResolvedValue(null);

    const result = await applyEvent(server, CONTRACT_ID, PASSPHRASE, decoded(WITHDRAWN));

    expect(result).toBe("missing");
    expect(streams.upsertStream).not.toHaveBeenCalled();
  });

  it("avoids the RPC when the stream row already exists", async () => {
    streams.applyWithdrawal.mockResolvedValue("applied");

    await applyEvent(server, CONTRACT_ID, PASSPHRASE, decoded(WITHDRAWN));

    expect(contract.fetchStream).not.toHaveBeenCalled();
  });

  it("avoids the RPC when the event is a duplicate", async () => {
    streams.applyWithdrawal.mockResolvedValue("duplicate");

    const result = await applyEvent(server, CONTRACT_ID, PASSPHRASE, decoded(WITHDRAWN));

    expect(result).toBe("duplicate");
    expect(contract.fetchStream).not.toHaveBeenCalled();
  });

  it("avoids the RPC for created events", async () => {
    streams.insertStream.mockResolvedValue("applied");

    await applyEvent(server, CONTRACT_ID, PASSPHRASE, decoded(0));

    expect(contract.fetchStream).not.toHaveBeenCalled();
  });
});
