// Integration test: cancel-then-withdraw sequence (#582)
//
// Replays the lifecycle a stream actually goes through against a real Postgres
// instance:
//
//   1. created          — full stream inserted with withdrawn=0
//   2. partial withdraw — withdrawn increments, withdrawable shrinks
//   3. cancel           — totalAmount frozen, recipientAmount still claimable
//   4. partial withdraw — recipient claims some of the remaining balance
//   5. final withdraw   — recipient claims the rest
//
// After each step the test calls GET /streams/:id and asserts the API fields
// that a client would branch on: withdrawn, withdrawable, locked, and status.
//
// Run with:
//   DATABASE_URL=postgresql://tricklepay_test:tricklepay_test@localhost:5433/tricklepay_test \
//     npx vitest run --project integration

import { PrismaClient } from "@prisma/client";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyEvent } from "../../src/indexer/apply.js";
import { streamRoutes } from "../../src/routes/streams.js";
import { buildServer } from "../../src/server.js";

import type { StreamEvent } from "../../src/chain/events.js";

const url = process.env.DATABASE_URL;
const enabled = !!url;

// A dummy RPC server stub — applyEvent only calls the chain when a delta
// arrives for an unknown stream. All events here are applied in order, so
// the stream is always present before any delta arrives.
const rpcStub = {} as Parameters<typeof applyEvent>[0];

const CONTRACT_ID = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// Use a fixed stream id that is unlikely to collide with any other suite.
const STREAM_ID = 582_000_000n;

// Stellar addresses used for all four events.
const SENDER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const RECIPIENT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TOKEN = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";
const TX_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Token amounts: 1_000_000_000 base units = 100 tokens (7 decimals).
const UNIT = 1_000_000_000n;
const TOTAL_AMOUNT = 100n * UNIT;       // 100 tokens total
const PARTIAL_WITHDRAW = 10n * UNIT;    // 10 tokens — first withdrawal
const RECIPIENT_AMOUNT = 40n * UNIT;    // 50 vested at cancel, 10 already withdrawn
const POST_CANCEL_PARTIAL = 10n * UNIT;
const POST_CANCEL_FINAL = RECIPIENT_AMOUNT - POST_CANCEL_PARTIAL;

// The stream runs entirely in the past so vestedAmount == totalAmount at any
// query time, keeping every derived-field assertion deterministic regardless of
// when the suite runs.
const START_TIME = 1_600_000_000n; // 2020-09-13
const END_TIME   = 1_700_000_000n; // 2023-11-14 (past)
const CLIFF_TIME = 1_620_000_000n; // between start and end
// The cancel timestamp becomes the new endTime; it must be between START_TIME
// and the original END_TIME so the frozen stream's endTime is in the past too.
const CANCEL_AT  = 1_650_000_000n; // 2022-04-15

// Each event needs a globally unique, monotonically increasing id so the
// idempotency guard works correctly.  The id format is "TOID-index", zero-padded
// to the lengths the real RPC uses.
const EV_CREATED        = "0000000100000000000000000-0000000001";
const EV_WITHDRAWN      = "0000000200000000000000000-0000000001";
const EV_CANCELLED      = "0000000300000000000000000-0000000001";
const EV_POST_CANCEL_PARTIAL = "0000000400000000000000000-0000000001";
const EV_FINAL_WITHDRAW = "0000000500000000000000000-0000000001";

// Build typed StreamEvent objects without going through the RPC decoder.
function createdEvent(): StreamEvent {
  return {
    kind: "created",
    id: EV_CREATED,
    ledger: 56_000_001,
    closedAt: START_TIME,
    txHash: TX_HASH,
    streamId: STREAM_ID,
    sender: SENDER,
    recipient: RECIPIENT,
    token: TOKEN,
    totalAmount: TOTAL_AMOUNT,
    startTime: START_TIME,
    endTime: END_TIME,
    cliffTime: CLIFF_TIME,
  };
}

function withdrawnEvent(): StreamEvent {
  return {
    kind: "withdrawn",
    id: EV_WITHDRAWN,
    ledger: 56_000_002,
    closedAt: START_TIME + 1n,
    txHash: TX_HASH,
    streamId: STREAM_ID,
    recipient: RECIPIENT,
    amount: PARTIAL_WITHDRAW,
  };
}

function cancelledEvent(): StreamEvent {
  return {
    kind: "cancelled",
    id: EV_CANCELLED,
    ledger: 56_000_003,
    closedAt: CANCEL_AT,
    txHash: TX_HASH,
    streamId: STREAM_ID,
    sender: SENDER,
    recipientAmount: RECIPIENT_AMOUNT,
    senderRefund: TOTAL_AMOUNT - PARTIAL_WITHDRAW - RECIPIENT_AMOUNT,
  };
}

function postCancelPartialEvent(): StreamEvent {
  return {
    kind: "withdrawn",
    id: EV_POST_CANCEL_PARTIAL,
    ledger: 56_000_004,
    closedAt: CANCEL_AT + 1n,
    txHash: TX_HASH,
    streamId: STREAM_ID,
    recipient: RECIPIENT,
    amount: POST_CANCEL_PARTIAL,
  };
}

// The recipient claims the remaining balance after cancellation.
function finalWithdrawnEvent(): StreamEvent {
  return {
    kind: "withdrawn",
    id: EV_FINAL_WITHDRAW,
    ledger: 56_000_005,
    closedAt: CANCEL_AT + 2n,
    txHash: TX_HASH,
    streamId: STREAM_ID,
    recipient: RECIPIENT,
    amount: POST_CANCEL_FINAL,
  };
}

let prisma: PrismaClient;

beforeAll(async () => {
  if (!enabled) return;
  prisma = new PrismaClient({ datasourceUrl: url });
  // Remove any leftover row from a previous run.
  await prisma.stream.deleteMany({ where: { streamId: STREAM_ID } });
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.stream.deleteMany({ where: { streamId: STREAM_ID } });
  await prisma.$disconnect();
});

describe("cancel-then-withdraw integration sequence", () => {
  // Build one server instance for the whole suite. afterAll closes it.
  let app: Awaited<ReturnType<typeof buildServer>>;

  // buildServer registers several Fastify plugins (swagger, swagger-ui, cors,
  // compress, security headers) which can exceed the default 10s hook timeout
  // on a cold start, so give it room.
  beforeAll(async () => {
    if (!enabled) return;
    app = await buildServer();
    await app.register(streamRoutes);
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    await app.close();
  });

  // Helper: GET /streams/:id and return the parsed body.
  async function fetchStream(id: bigint) {
    const response = await app.inject({
      method: "GET",
      url: `/streams/${id.toString()}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      withdrawn: string;
      withdrawable: string;
      locked: string;
      status: string;
      cancelled: boolean;
      totalAmount: string;
    };
  }

  it("event 1 — created: withdrawn=0, withdrawable=total, locked=0, status=completed", async () => {
    if (!enabled) return;

    const outcome = await applyEvent(rpcStub, CONTRACT_ID, NETWORK_PASSPHRASE, createdEvent());
    expect(outcome).toBe("applied");

    const body = await fetchStream(STREAM_ID);

    // Stream is entirely in the past, so the full totalAmount is vested.
    expect(body.withdrawn).toBe("0");
    expect(body.withdrawable).toBe(TOTAL_AMOUNT.toString());
    expect(body.locked).toBe("0");
    expect(body.status).toBe("completed");
    expect(body.cancelled).toBe(false);
  });

  it("event 2 — partial withdrawal: withdrawn grows, withdrawable shrinks", async () => {
    if (!enabled) return;

    const outcome = await applyEvent(rpcStub, CONTRACT_ID, NETWORK_PASSPHRASE, withdrawnEvent());
    expect(outcome).toBe("applied");

    const body = await fetchStream(STREAM_ID);

    const expectedWithdrawable = (TOTAL_AMOUNT - PARTIAL_WITHDRAW).toString();

    expect(body.withdrawn).toBe(PARTIAL_WITHDRAW.toString());
    expect(body.withdrawable).toBe(expectedWithdrawable);
    expect(body.locked).toBe("0");
    expect(body.status).toBe("completed");
    expect(body.cancelled).toBe(false);
  });

  it("event 3 — cancellation leaves the recipient amount claimable", async () => {
    if (!enabled) return;

    const outcome = await applyEvent(rpcStub, CONTRACT_ID, NETWORK_PASSPHRASE, cancelledEvent());
    expect(outcome).toBe("applied");

    const body = await fetchStream(STREAM_ID);

    // After cancel: frozenTotal = old withdrawn + recipientAmount
    const frozenTotal = (PARTIAL_WITHDRAW + RECIPIENT_AMOUNT).toString();

    // The API reports totalAmount as the frozen total.
    expect(body.totalAmount).toBe(frozenTotal);
    expect(body.withdrawn).toBe(PARTIAL_WITHDRAW.toString());
    expect(body.withdrawable).toBe(RECIPIENT_AMOUNT.toString());
    // The frozen total is fully vested, so locked is 0.
    expect(body.locked).toBe("0");
    expect(body.status).toBe("cancelled");
    expect(body.cancelled).toBe(true);
  });

  it("event 4 — partial withdrawal after cancellation reduces the claimable balance", async () => {
    if (!enabled) return;

    const outcome = await applyEvent(rpcStub, CONTRACT_ID, NETWORK_PASSPHRASE, postCancelPartialEvent());
    expect(outcome).toBe("applied");

    const body = await fetchStream(STREAM_ID);
    const frozenTotal = (PARTIAL_WITHDRAW + RECIPIENT_AMOUNT).toString();
    expect(body.totalAmount).toBe(frozenTotal);
    expect(body.withdrawn).toBe((PARTIAL_WITHDRAW + POST_CANCEL_PARTIAL).toString());
    expect(body.withdrawable).toBe(POST_CANCEL_FINAL.toString());
    expect(body.locked).toBe("0");
    expect(body.status).toBe("cancelled");
  });

  it("event 5 — final withdrawal brings withdrawn to the frozen total", async () => {
    if (!enabled) return;

    const outcome = await applyEvent(rpcStub, CONTRACT_ID, NETWORK_PASSPHRASE, finalWithdrawnEvent());
    expect(outcome).toBe("applied");

    const body = await fetchStream(STREAM_ID);
    const frozenTotal = (PARTIAL_WITHDRAW + RECIPIENT_AMOUNT).toString();
    expect(body.totalAmount).toBe(frozenTotal);
    expect(body.withdrawn).toBe(frozenTotal);
    expect(body.withdrawable).toBe("0");
    expect(body.locked).toBe("0");
    expect(body.status).toBe("cancelled");
    expect(body.cancelled).toBe(true);
  });
});
