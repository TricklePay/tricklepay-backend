import { EventEmitter } from "node:events";
import type { Stream } from "@prisma/client";
import type { StreamEvent } from "./chain/events.js";

// Event payload when a stream is updated
export interface StreamUpdateEvent {
  streamId: bigint;
  kind: "created" | "withdrawn" | "cancelled";
  stream: Stream;
  eventId: string;
  ledger: number;
}

// Global event bus for stream updates.
// The poller emits events here after successfully applying them,
// and SSE endpoints subscribe to receive updates for specific streams.
class StreamEventBus extends EventEmitter {
  // Emit a stream update after an event has been successfully applied
  emitStreamUpdate(update: StreamUpdateEvent): void {
    // Emit to stream-specific channel
    this.emit(`stream:${update.streamId.toString()}`, update);
    // Also emit to global channel for per-address subscriptions if needed
    this.emit("stream:*", update);
  }

  // Subscribe to updates for a specific stream
  onStreamUpdate(
    streamId: bigint,
    handler: (update: StreamUpdateEvent) => void,
  ): () => void {
    const channel = `stream:${streamId.toString()}`;
    this.on(channel, handler);
    return () => this.off(channel, handler);
  }

  // Subscribe to all stream updates
  onAnyStreamUpdate(handler: (update: StreamUpdateEvent) => void): () => void {
    this.on("stream:*", handler);
    return () => this.off("stream:*", handler);
  }
}

export const streamEventBus = new StreamEventBus();
