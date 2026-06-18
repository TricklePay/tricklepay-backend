import { rpc } from "@stellar/stellar-sdk";
import type { StreamEvent } from "../chain/events.js";
import { fetchStream } from "../chain/contract.js";
import { upsertStream } from "../repositories/streams.js";

// Applies a decoded event by reading the stream's authoritative state from the
// contract and writing it to the database. Events that only carry deltas (a
// withdrawal amount, a cancellation split) do not include the full stream, so
// reading current state keeps the stored row complete and correct regardless of
// which event triggered the update.
export async function applyEvent(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  event: StreamEvent,
): Promise<void> {
  const onChain = await fetchStream(server, contractId, networkPassphrase, event.streamId);
  if (!onChain) return;

  await upsertStream({
    streamId: event.streamId,
    ...onChain,
    ledger: event.ledger,
  });
}
