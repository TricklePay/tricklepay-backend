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

export type ApplyOutcome =
  | "applied"
  | "duplicate"
  | "reconciled"
  | "missing";

type CreatedEvent = Extract<StreamEvent, { kind: "created" }>;
type WithdrawnEvent = Extract<StreamEvent, { kind: "withdrawn" }>;
type CancelledEvent = Extract<StreamEvent, { kind: "cancelled" }>;

interface EventContext {
  server: rpc.Server;
  contractId: string;
  networkPassphrase: string;
  tx?: Prisma.TransactionClient;
}

/**
 * Applies stream events to the local indexed database.
 *
 * `applied`      - Event was successfully applied.
 * `duplicate`     - Event was already processed.
 * `reconciled`   - Local state was rebuilt from on-chain state.
 * `missing`       - Stream was unavailable locally and on-chain.
 */
export async function applyEvent(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  event: StreamEvent,
  tx?: Prisma.TransactionClient,
): Promise<ApplyOutcome> {
  const context: EventContext = {
    server,
    contractId,
    networkPassphrase,
    tx,
  };

  switch (event.kind) {
    case "created":
      return handleCreated(event, context);

    case "withdrawn":
      return handleWithdrawn(event, context);

    case "cancelled":
      return handleCancelled(event, context);

    default: {
      // Exhaustiveness guard: compilation fails if a new event kind
      // is introduced but not handled here.
      const exhaustiveCheck: never = event;
      throw new Error(`Unhandled stream event: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Creation events contain the complete stream state, so no RPC
 * reconciliation is necessary.
 */
async function handleCreated(
  event: CreatedEvent,
  { tx }: EventContext,
): Promise<ApplyOutcome> {
  return insertStream(
    {
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
    },
    tx,
  );
}

/**
 * Withdrawal events carry a delta that can be applied to an existing row.
 * Reconciliation is only required when the stream is missing locally.
 */
async function handleWithdrawn(
  event: WithdrawnEvent,
  context: EventContext,
): Promise<ApplyOutcome> {
  const { tx } = context;

  const result = await applyWithdrawal(
    {
      streamId: event.streamId,
      amount: event.amount,
      ledger: event.ledger,
      eventId: event.id,
    },
    tx,
  );

  return reconcileIfMissing(result, event, context);
}

/**
 * Cancellation events carry cancellation data that can be applied
 * directly to the local stream mirror.
 */
async function handleCancelled(
  event: CancelledEvent,
  context: EventContext,
): Promise<ApplyOutcome> {
  const { tx } = context;

  const result = await applyCancellation(
    {
      streamId: event.streamId,
      recipientAmount: event.recipientAmount,
      cancelledAt: event.closedAt,
      ledger: event.ledger,
      eventId: event.id,
    },
    tx,
  );

  return reconcileIfMissing(result, event, context);
}

/**
 * Delta events cannot be applied when the local stream row is absent.
 *
 * In that case, read the authoritative contract state and rebuild
 * the local mirror. Subsequent events can use the normal delta path.
 */
async function reconcileIfMissing(
  result: ApplyResult,
  event: WithdrawnEvent | CancelledEvent,
  context: EventContext,
): Promise<ApplyOutcome> {
  if (result !== "missing") {
    return result;
  }

  const {
    server,
    contractId,
    networkPassphrase,
    tx,
  } = context;

  const onChainStream = await fetchStream(
    server,
    contractId,
    networkPassphrase,
    event.streamId,
  );

  if (!onChainStream) {
    return "missing";
  }

  await upsertStream(
    {
      streamId: event.streamId,
      ...onChainStream,
      ledger: event.ledger,
      eventId: event.id,
    },
    tx,
  );

  return "reconciled";
}