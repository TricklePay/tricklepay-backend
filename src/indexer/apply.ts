import type { Prisma } from "@prisma/client";

import { rpc } from "@stellar/stellar-sdk";

import { fetchStream } from "../chain/contract.js";

import type { StreamEvent } from "../chain/events.js";

import {
  applyCancellation,
  applyWithdrawal,
  insertStream,
  upsertStream,
  type ApplyResult,
} from "../repositories/streams.js";

// What applying an event did to the stored mirror. `reconciled` means the
// event's own data could not be used and full contract state was read instead;
// `missing` means the stream is neither stored nor on chain, so there was
// nothing to write.
export type ApplyOutcome = "applied" | "duplicate" | "reconciled" | "missing";

type EventHandler<E extends StreamEvent = StreamEvent> = (
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  event: E,
  tx?: Prisma.TransactionClient,
) => Promise<ApplyOutcome>;

type CreatedEvent = Extract<StreamEvent, { kind: "created" }>;
type WithdrawnEvent = Extract<StreamEvent, { kind: "withdrawn" }>;
type CancelledEvent = Extract<StreamEvent, { kind: "cancelled" }>;

const eventHandlers: {
  created: EventHandler<CreatedEvent>;
  withdrawn: EventHandler<WithdrawnEvent>;
  cancelled: EventHandler<CancelledEvent>;
} = {
  created: async (_server, _contractId, _networkPassphrase, event, tx) =>
    insertStream({
      streamId: event.streamId,
      sender: event.sender,
      recipient: event.recipient,
      token: event.token,
      totalAmount: event.totalAmount,
      startTime: event.startTime,
      endTime: event.endTime,
      cliffTime: event.cliffTime,
      ledger: event.ledger,
      eventId: event.id,
    }, tx),

  withdrawn: async (server, contractId, networkPassphrase, event, tx) =>
    orReconcile(
      await applyWithdrawal({
        streamId: event.streamId,
        amount: event.amount,
        ledger: event.ledger,
        eventId: event.id,
      }, tx),
      server, contractId, networkPassphrase, event, tx,
    ),

  cancelled: async (server, contractId, networkPassphrase, event, tx) =>
    orReconcile(
      await applyCancellation({
        streamId: event.streamId,
        recipientAmount: event.recipientAmount,
        cancelledAt: event.closedAt,
        ledger: event.ledger,
        eventId: event.id,
      }, tx),
      server, contractId, networkPassphrase, event, tx,
    ),
};

// Applies a decoded event by writing what the event itself carries. `created`
// carries the whole stream, and `withdrawn` and `cancelled` carry deltas the
// stored row can absorb, so the ordinary path is a single database write and no
// network round-trip. That is what makes a backfill cheap: the cost of an
// historical event is one query, not one RPC simulation.
//
// Every write is guarded on the event id, so replaying a page of events — which
// happens whenever the indexer restarts before its cursor is saved — applies
// each event at most once.
export async function applyEvent(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  event: StreamEvent,
  tx?: Prisma.TransactionClient
): Promise<ApplyOutcome> {
  const handler = eventHandlers[event.kind] as EventHandler<typeof event>;
  return handler(server, contractId, networkPassphrase, event, tx);
}

// A delta only makes sense against a row that exists. When one arrives for an
// unknown stream — an indexer backfilling from a ledger after the stream was
// created, or one whose row was lost — full state is read from the contract and
// written whole. This is the only path that still calls the chain, and it runs
// once per stream rather than once per event: afterwards the row is present and
// later deltas apply straight to it.
async function orReconcile(
  result: ApplyResult,
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  event: StreamEvent,
  tx?: Prisma.TransactionClient
): Promise<ApplyOutcome> {
  if (result !== "missing") return result;

  const onChain = await fetchStream(server, contractId, networkPassphrase, event.streamId);
  if (!onChain) return "missing";

  await upsertStream({
    streamId: event.streamId,
    ...onChain,
    ledger: event.ledger,
    eventId: event.id,
  }, tx);
  return "reconciled";
}
