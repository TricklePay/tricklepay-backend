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
      ledger: 56123890,
      txHash: "9f2a1c7b04e5d3806a1f9c2be47d05138af6e29c0b7143d5e8a26f90cd41b7e3",
    });
  });

  it("decodes a withdrawn event", () => {
    expect(decodeEvent(page.events[WITHDRAWN])).toEqual({
      kind: "withdrawn",
      streamId: 42n,
      recipient: RECIPIENT,
      amount: 2_500_000n * UNIT,
      ledger: 56201455,
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
      ledger: 56290012,
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

  it("ignores payload fields it does not store", () => {
    // The created payload also carries start_time, end_time and cliff_time; the
    // indexer reads those from `get_stream` instead, so they must not leak into
    // the decoded event.
    expect(Object.keys(decodeEvent(page.events[CREATED]) ?? {}).sort()).toEqual([
      "kind",
      "ledger",
      "recipient",
      "sender",
      "streamId",
      "token",
      "totalAmount",
      "txHash",
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
