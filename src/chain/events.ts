import { scValToNative } from "@stellar/stellar-sdk";

import type { rpc } from "@stellar/stellar-sdk";

import { toUnixSeconds } from "../lib/time.js";

// Typed representations of the events the stream contract emits. Each mirrors a
// `#[contractevent]` struct: the first topic is the event name, the remaining
// topics are the indexed fields, and the value is a map of the rest.

export interface BaseEvent {
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

// Maximum value for a uint128: 2^128 - 1.
const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * Guards against amounts that are out of the unsigned 128-bit integer range.
 *
 * Contract events encode amounts as uint128. A negative value or one above
 * `2^128 − 1` indicates a malformed or adversarial payload and should never
 * be written to the database.
 *
 * @param value - The decoded bigint amount to validate.
 * @param field - The name of the field being checked, used in the error message.
 * @throws {InvalidEventError} When `value` is negative or exceeds the uint128 maximum.
 */
function validateAmount(value: bigint, field: string): void {
  if (typeof value !== "bigint") {
    throw new InvalidEventError(`amount field "${field}" is missing or invalid`);
  }
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

function requireTopic(topics: unknown[], index: number, field: string): unknown {
  if (!Array.isArray(topics) || topics[index] === undefined || topics[index] === null) {
    throw new InvalidEventError(`topic field "${field}" is missing`);
  }
  return topics[index];
}

function requireBigInt(data: Record<string, unknown>, field: string): bigint {
  const value = data[field];
  if (typeof value !== "bigint") {
    throw new InvalidEventError(`field "${field}" is missing or invalid`);
  }
  return value;
}

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== "string") {
    throw new InvalidEventError(`field "${field}" is missing or invalid`);
  }
  return value;
}

/**
 * Decodes one Stellar RPC event into a typed stream event.
 *
 * Returns `null` for any event whose name is not recognized by this indexer.
 * Unknown events are silently skipped rather than treated as errors so the
 * contract can emit new event kinds without breaking existing indexer
 * deployments.
 *
 * The first topic of every contract event is the event name. For `created`
 * events, topics[1] and topics[2] carry the indexed `sender` and `recipient`
 * addresses respectively; for `withdrawn` and `cancelled` events, topics[1]
 * carries the relevant party. All remaining fields come from the event value
 * map decoded by `scValToNative`.
 *
 * @param event - A raw event object returned by the Stellar RPC `getEvents` call.
 * @returns A typed `StreamEvent` (discriminated by `kind`), or `null` if the
 *   event name is not one this indexer handles.
 * @throws {InvalidEventError} When the event id or ledger metadata is malformed,
 *   the ledger close timestamp cannot be parsed, or an amount field is outside
 *   the valid uint128 range.
 */
export function decodeEvent(event: rpc.Api.EventResponse): StreamEvent | null {
  try {
    const topics = event.topic;
    if (!Array.isArray(topics) || topics.length === 0) return null;

    // Validate metadata before decoding the payload.
    if (!event.id || typeof event.id !== "string" || event.id.trim().length === 0) {
      throw new InvalidEventError("event id is empty");
    }
    if (typeof event.ledger !== "number" || event.ledger <= 0) {
      throw new InvalidEventError(`event ledger must be positive, got ${event.ledger}`);
    }

    const closedAt = toUnixSeconds(event.ledgerClosedAt);
    if (typeof closedAt === "number" && Number.isNaN(closedAt)) {
      throw new InvalidEventError(`event ledgerClosedAt is not parseable: ${event.ledgerClosedAt}`);
    }

    const name = scValToNative(topics[0]) as string;
    const rawData = scValToNative(event.value);
    if (rawData === null || rawData === undefined || typeof rawData !== "object" || Array.isArray(rawData)) {
      throw new InvalidEventError("event data is missing or invalid");
    }
    const data = rawData as Record<string, unknown>;
    const base: BaseEvent = {
      id: event.id,
      ledger: event.ledger,
      closedAt: closedAt as bigint,
      txHash: event.txHash,
    };

    switch (name) {
      case "created": {
        requireTopic(topics, 1, "sender");
        requireTopic(topics, 2, "recipient");
        const totalAmount = requireBigInt(data, "total_amount");
        validateAmount(totalAmount, "total_amount");
        const sender = scValToNative(topics[1]);
        const recipient = scValToNative(topics[2]);
        if (typeof sender !== "string") {
          throw new InvalidEventError("topic field \"sender\" is missing or invalid");
        }
        if (typeof recipient !== "string") {
          throw new InvalidEventError("topic field \"recipient\" is missing or invalid");
        }
        const streamId = requireBigInt(data, "id");
        const token = requireString(data, "token");
        const startTime = requireBigInt(data, "start_time");
        const endTime = requireBigInt(data, "end_time");
        const cliffTime = requireBigInt(data, "cliff_time");
        return {
          kind: "created",
          ...base,
          sender,
          recipient,
          streamId,
          token,
          totalAmount,
          startTime,
          endTime,
          cliffTime,
        };
      }
      case "withdrawn": {
        requireTopic(topics, 1, "recipient");
        const amount = requireBigInt(data, "amount");
        validateAmount(amount, "amount");
        const recipient = scValToNative(topics[1]);
        if (typeof recipient !== "string") {
          throw new InvalidEventError("topic field \"recipient\" is missing or invalid");
        }
        const streamId = requireBigInt(data, "id");
        return {
          kind: "withdrawn",
          ...base,
          recipient,
          streamId,
          amount,
        };
      }
      case "cancelled": {
        requireTopic(topics, 1, "sender");
        const recipientAmount = requireBigInt(data, "recipient_amount");
        const senderRefund = requireBigInt(data, "sender_refund");
        validateAmount(recipientAmount, "recipient_amount");
        validateAmount(senderRefund, "sender_refund");
        const sender = scValToNative(topics[1]);
        if (typeof sender !== "string") {
          throw new InvalidEventError("topic field \"sender\" is missing or invalid");
        }
        const streamId = requireBigInt(data, "id");
        return {
          kind: "cancelled",
          ...base,
          sender,
          streamId,
          recipientAmount,
          senderRefund,
        };
      }
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof InvalidEventError) {
      throw err;
    }
    if (err instanceof Error) {
      throw new InvalidEventError(err.message);
    }
    throw new InvalidEventError(String(err));
  }
}
