import type { FastifyInstance } from "fastify";
import type { Stream } from "@prisma/client";
import { countStreams, getStream, listStreams } from "../repositories/streams.js";
import { vestedAmount, withdrawableAmount } from "../lib/vesting.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function statusOf(stream: Stream, now: bigint): StreamStatus {
  if (stream.cancelled) return "cancelled";
  if (now < stream.startTime) return "pending";
  if (now >= stream.endTime) return "completed";
  return "streaming";
}

// Shapes a stored stream into the API response, computing vested and
// withdrawable amounts against the current clock so clients see live figures
// without querying the chain.
function toView(stream: Stream) {
  const now = nowSeconds();
  const total = BigInt(stream.totalAmount.toString());
  const withdrawn = BigInt(stream.withdrawn.toString());
  const vested = vestedAmount(total, stream.startTime, stream.endTime, stream.cliffTime, now);
  const withdrawable = withdrawableAmount(vested, withdrawn);
  const locked = total - vested;
  // Vesting progress in basis points, from 0 to 10000, matching the contract.
  const progress = total === 0n ? 10000 : Number((vested * 10000n) / total);

  return {
    id: stream.streamId.toString(),
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    totalAmount: total.toString(),
    withdrawn: withdrawn.toString(),
    vested: vested.toString(),
    withdrawable: withdrawable.toString(),
    locked: locked.toString(),
    progress,
    startTime: stream.startTime.toString(),
    endTime: stream.endTime.toString(),
    cliffTime: stream.cliffTime.toString(),
    cancelled: stream.cancelled,
    status: statusOf(stream, now),
  };
}

function parseLimit(raw: string | undefined): number {
  const value = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function parseOffset(raw: string | undefined): number {
  const value = raw ? Number(raw) : 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/streams", async (request) => {
    const query = request.query as {
      sender?: string;
      recipient?: string;
      limit?: string;
      offset?: string;
    };

    const limit = parseLimit(query.limit);
    const offset = parseOffset(query.offset);
    const filter = { sender: query.sender, recipient: query.recipient };

    const [streams, total] = await Promise.all([
      listStreams({ ...filter, limit, offset }),
      countStreams(filter),
    ]);

    return { streams: streams.map(toView), total, limit, offset };
  });

  app.get("/streams/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    let streamId: bigint;
    try {
      streamId = BigInt(id);
    } catch {
      return reply.code(400).send({ error: "invalid stream id" });
    }

    const stream = await getStream(streamId);
    if (!stream) {
      return reply.code(404).send({ error: "stream not found" });
    }

    return toView(stream);
  });
}
