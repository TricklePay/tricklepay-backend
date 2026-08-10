import { rpc } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeEvent } from "../../src/chain/events.js";
import capture from "../fixtures/get-events.json" with { type: "json" };

// `decodeEvent` is the one place the indexer interprets raw chain data, so it is
// exercised here the way the poller reaches it: a captured `getEvents` JSON-RPC
// response goes through the SDK's own `parseRawEvents`, exactly as
// `rpc.Server.getEvents` does, and the resulting `EventResponse` objects are
// decoded. Nothing is hand-built from ScVals, so the base64 XDR in the fixture
// is what is actually under test.

const page = rpc.parseRawEvents(capture.result as unknown as rpc.Api.RawGetEventsResponse);

const SENDER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const RECIPIENT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TREASURY = "CAXZU7AE4GZVRVSHBLURFROY6MDBUS7JPUQDQ3HVDFFH3YFTYYUBLERT";
const TOKEN = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";

// The captured stream moves 10,000,000 units of a seven-decimal token, so the
// amounts below are in base units: 1 unit = 10_000_000.
const UNIT = 10_000_000n;

// Positions in the captured page, in the order the RPC returned them.
const CREATED = 0;
const WITHDRAWN = 1;
const CANCELLED = 2;
const CREATED_AT_LIMITS = 3;
const PAUSED = 4;
const SCHEDULE_EXTENDED = 5;

beforeAll(() => {
  // Guards the indices above: a fixture edit that reorders or drops an event
  // should fail here rather than silently weaken every assertion below.
  expect(page.events).toHaveLength(6);
});

describe("decodeEvent", () => {
  it("decodes a created event", () => {
    expect(decodeEvent(page.events[CREATED])).toEqual({
      kind: "created",
      streamId: 42n,
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      totalAmount: 10_000_000n * UNIT,
      startTime: 1735689600n,
      endTime: 1767225600n,
      cliffTime: 1740000000n,
      id: "0241050272077447168-0000000001",
      ledger: 56123890,
      closedAt: 1762161262n, // 2025-11-03T09:14:22Z
      txHash: "9f2a1c7b04e5d3806a1f9c2be47d05138af6e29c0b7143d5e8a26f90cd41b7e3",
    });
  });

  it("decodes a withdrawn event", () => {
    expect(decodeEvent(page.events[WITHDRAWN])).toEqual({
      kind: "withdrawn",
      streamId: 42n,
      recipient: RECIPIENT,
      amount: 2_500_000n * UNIT,
      id: "0241383411213664256-0000000001",
      ledger: 56201455,
      closedAt: 1762623665n, // 2025-11-08T17:41:05Z
      txHash: "3c8e05f19a2d47b6c0138e5fa9270db461c39e8057af2d16b904ce7328fd51a0",
    });
  });

  it("decodes a cancelled event", () => {
    expect(decodeEvent(page.events[CANCELLED])).toEqual({
      kind: "cancelled",
      streamId: 42n,
      sender: SENDER,
      recipientAmount: 3_000_000n * UNIT,
      senderRefund: 7_000_000n * UNIT,
      id: "0241763760638787584-0000000001",
      ledger: 56290012,
      closedAt: 1763089117n, // 2025-11-14T02:58:37Z
      txHash: "c1740b3e96af52d80e2b6c19d7503fa8412e7bd6039c85af17e2604db3958cf1",
    });
  });

  it("keeps u64 and i128 fields at full precision", () => {
    // Both values are past Number.MAX_SAFE_INTEGER, so a decoder that let them
    // through a float would round them.
    expect(decodeEvent(page.events[CREATED_AT_LIMITS])).toMatchObject({
      streamId: 18_446_744_073_709_551_615n,
      totalAmount: 170_141_183_460_469_231_731_687_303_715_884_105_727n,
    });
  });

  it("decodes a contract address sender as a contract strkey", () => {
    // Senders can be contracts as well as accounts; both arrive as ScAddress.
    expect(decodeEvent(page.events[CREATED_AT_LIMITS])).toMatchObject({
      sender: TREASURY,
      recipient: RECIPIENT,
    });
  });

  it("round-trips the schedule fields from the created payload", () => {
    // The contract carries start_time, end_time and cliff_time on Created so an
    // indexer can record the whole schedule from the event alone. They are u64
    // seconds; the bigint literals below also pin the type, since toMatchObject
    // compares primitives strictly and 1735689600n !== 1735689600.
    expect(decodeEvent(page.events[CREATED])).toMatchObject({
      startTime: 1735689600n, // 2025-01-01T00:00:00Z
      endTime: 1767225600n, // 2026-01-01T00:00:00Z
      cliffTime: 1740000000n, // between start and end
    });
  });

  it("round-trips a schedule with no cliff and a zero start", () => {
    // cliff_time == start_time is how the contract expresses "no cliff"; the
    // decoder must pass the value through rather than normalise it away.
    expect(decodeEvent(page.events[CREATED_AT_LIMITS])).toMatchObject({
      startTime: 0n,
      endTime: 1n,
      cliffTime: 0n,
    });
  });

  it("decodes the created payload into exactly the declared fields", () => {
    // The whole Created payload is now consumed — topics for the addresses, the
    // value map for the id, token, amount and schedule. Nothing is dropped, and
    // nothing extra leaks in.
    expect(Object.keys(decodeEvent(page.events[CREATED]) ?? {}).sort()).toEqual([
      "cliffTime",
      "closedAt",
      "endTime",
      "id",
      "kind",
      "ledger",
      "recipient",
      "sender",
      "startTime",
      "streamId",
      "token",
      "totalAmount",
      "txHash",
    ]);
  });

  it("carries the event id and close time from the RPC envelope", () => {
    // The envelope fields, not the payload: the id makes applying an event
    // idempotent across a replayed page, and the close time is the clock the
    // contract saw, which a cancellation freezes the stream at.
    const decoded = page.events.map(decodeEvent).filter((event) => event !== null);

    expect(decoded.map((event) => event.id)).toEqual([
      "0241050272077447168-0000000001",
      "0241383411213664256-0000000001",
      "0241763760638787584-0000000001",
      "0241763764928512000-0000000001",
    ]);
    // Fixed width and zero padded, so sorting them as strings is chain order.
    expect([...decoded].map((event) => event.id).sort()).toEqual(decoded.map((event) => event.id));
    expect(decoded.map((event) => event.closedAt)).toEqual([
      1762161262n,
      1762623665n,
      1763089117n,
      1763089122n,
    ]);
  });

  it("skips an unknown event with a scalar payload", () => {
    // A future `paused` event: the name is unrecognised and the value is not a
    // map, so decoding must return null rather than throw.
    expect(decodeEvent(page.events[PAUSED])).toBeNull();
  });

  it("skips an unknown event with a map payload", () => {
    expect(decodeEvent(page.events[SCHEDULE_EXTENDED])).toBeNull();
  });

  it("skips an event with no topics", () => {
    // Not something the RPC returns today, hence built from a captured event
    // rather than the fixture; the guard exists so a malformed page cannot
    // crash the poller mid-batch.
    expect(decodeEvent({ ...page.events[CREATED], topic: [] })).toBeNull();
  });

  it("decodes a whole page the way the poller does", () => {
    // The poller maps the page and drops the nulls; what survives must be the
    // three known events, in ledger order, with unknown ones filtered out.
    const decoded = page.events.map(decodeEvent).filter((event) => event !== null);

    expect(decoded.map((event) => event.kind)).toEqual([
      "created",
      "withdrawn",
      "cancelled",
      "created",
    ]);
    expect(decoded.map((event) => event.ledger)).toEqual([
      56123890, 56201455, 56290012, 56290013,
    ]);
  });
});
