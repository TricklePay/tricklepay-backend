import { scValToNative } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";

// Typed representations of the events the stream contract emits. Each mirrors a
// `#[contractevent]` struct: the first topic is the event name, the remaining
// topics are the indexed fields, and the value is a map of the rest.

interface BaseEvent {
  ledger: number;
  txHash: string;
}

export interface CreatedEvent extends BaseEvent {
  kind: "created";
  streamId: bigint;
  sender: string;
  recipient: string;
  token: string;
  totalAmount: bigint;
}

export interface WithdrawnEvent extends BaseEvent {
  kind: "withdrawn";
  streamId: bigint;
  recipient: string;
  amount: bigint;
}

export interface CancelledEvent extends BaseEvent {
  kind: "cancelled";
  streamId: bigint;
  sender: string;
  recipientAmount: bigint;
  senderRefund: bigint;
}

export type StreamEvent = CreatedEvent | WithdrawnEvent | CancelledEvent;

// Decodes one RPC event into a typed stream event, or returns null if the
// event is not one this indexer understands. Unknown events are skipped rather
// than treated as errors so the contract can add events without breaking the
// indexer.
export function decodeEvent(event: rpc.Api.EventResponse): StreamEvent | null {
  const topics = event.topic;
  if (topics.length === 0) return null;

  const name = scValToNative(topics[0]) as string;
  const data = scValToNative(event.value) as Record<string, bigint | string>;
  const base: BaseEvent = { ledger: event.ledger, txHash: event.txHash };

  switch (name) {
    case "created":
      return {
        kind: "created",
        ...base,
        sender: scValToNative(topics[1]) as string,
        recipient: scValToNative(topics[2]) as string,
        streamId: data.id as bigint,
        token: data.token as string,
        totalAmount: data.total_amount as bigint,
      };
    case "withdrawn":
      return {
        kind: "withdrawn",
        ...base,
        recipient: scValToNative(topics[1]) as string,
        streamId: data.id as bigint,
        amount: data.amount as bigint,
      };
    case "cancelled":
      return {
        kind: "cancelled",
        ...base,
        sender: scValToNative(topics[1]) as string,
        streamId: data.id as bigint,
        recipientAmount: data.recipient_amount as bigint,
        senderRefund: data.sender_refund as bigint,
      };
    default:
      return null;
  }
}
