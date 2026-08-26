import { scValToNative } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";

// Typed representations of the events the stream contract emits. Each mirrors a
// `#[contractevent]` struct: the first topic is the event name, the remaining
// topics are the indexed fields, and the value is a map of the rest.

interface BaseEvent {
  // The RPC's globally unique event id, `TOID-index`. Both halves are zero
  // padded to a fixed width, so comparing ids as strings orders them the way
  // the chain emitted them. Recording the last id applied to a stream is what
  // lets a delta event (a withdrawal amount) be applied exactly once even when
  // a page of events is replayed.
  id: string;
  ledger: number;
  // Ledger close time in Unix seconds: the clock the contract itself saw when
  // it emitted this event, and so the timestamp it wrote into any state the
  // event describes.
  closedAt: bigint;
  txHash: string;
}

export interface CreatedEvent extends BaseEvent {
  kind: "created";
  streamId: bigint;
  sender: string;
  recipient: string;
  token: string;
  totalAmount: bigint;
  // The vesting schedule, in Unix seconds. The contract puts these in the
  // payload so a consumer can record the whole stream from the event alone,
  // without a follow-up `get_stream` call.
  startTime: bigint;
  endTime: bigint;
  cliffTime: bigint;
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

// The RPC reports ledger close time as an RFC 3339 timestamp; the contract
// works in whole Unix seconds, so the two agree once the string is converted.
// Returns NaN when the timestamp cannot be parsed, which the caller rejects.
function closedAtSeconds(ledgerClosedAt: string): bigint | typeof NaN {
  const ms = Date.parse(ledgerClosedAt);
  if (Number.isNaN(ms)) return NaN;
  return BigInt(Math.floor(ms / 1000));
}

// Maximum value for a uint128: 2^128 - 1.
const MAX_UINT128 = (1n << 128n) - 1n;

// Rejects amounts that are negative or exceed the uint128 range. Contract
// events encode unsigned 128-bit integers, so a negative value or one above
// the maximum indicates a malformed or adversarial payload.
function validateAmount(value: bigint, field: string): void {
  if (value < 0n || value > MAX_UINT128) {
    throw new InvalidEventError(`amount field "${field}" out of uint128 range: ${value}`);
  }
}

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

// Decodes one RPC event into a typed stream event, or returns null if the
// event is not one this indexer understands. Unknown events are skipped rather
// than treated as errors so the contract can add events without breaking the
// indexer. Throws InvalidEventError when metadata or amounts are malformed.
export function decodeEvent(event: rpc.Api.EventResponse): StreamEvent | null {
  const topics = event.topic;
  if (topics.length === 0) return null;

  // Validate metadata before decoding the payload.
  if (!event.id || event.id.trim().length === 0) {
    throw new InvalidEventError("event id is empty");
  }
  if (event.ledger <= 0) {
    throw new InvalidEventError(`event ledger must be positive, got ${event.ledger}`);
  }

  const closedAt = closedAtSeconds(event.ledgerClosedAt);
  if (typeof closedAt === "number" && Number.isNaN(closedAt)) {
    throw new InvalidEventError(`event ledgerClosedAt is not parseable: ${event.ledgerClosedAt}`);
  }

  const name = scValToNative(topics[0]) as string;
  const data = scValToNative(event.value) as Record<string, bigint | string>;
  const base: BaseEvent = {
    id: event.id,
    ledger: event.ledger,
    closedAt: closedAt as bigint,
    txHash: event.txHash,
  };

  switch (name) {
    case "created": {
      const totalAmount = data.total_amount as bigint;
      validateAmount(totalAmount, "total_amount");
      return {
        kind: "created",
        ...base,
        sender: scValToNative(topics[1]) as string,
        recipient: scValToNative(topics[2]) as string,
        streamId: data.id as bigint,
        token: data.token as string,
        totalAmount,
        startTime: data.start_time as bigint,
        endTime: data.end_time as bigint,
        cliffTime: data.cliff_time as bigint,
      };
    }
    case "withdrawn": {
      const amount = data.amount as bigint;
      validateAmount(amount, "amount");
      return {
        kind: "withdrawn",
        ...base,
        recipient: scValToNative(topics[1]) as string,
        streamId: data.id as bigint,
        amount,
      };
    }
    case "cancelled": {
      const recipientAmount = data.recipient_amount as bigint;
      const senderRefund = data.sender_refund as bigint;
      validateAmount(recipientAmount, "recipient_amount");
      validateAmount(senderRefund, "sender_refund");
      return {
        kind: "cancelled",
        ...base,
        sender: scValToNative(topics[1]) as string,
        streamId: data.id as bigint,
        recipientAmount,
        senderRefund,
      };
    }
    default:
      return null;
  }
}
