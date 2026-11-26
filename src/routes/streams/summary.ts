// GET /streams/summary: counts and totals per lifecycle status, cached in memory.

import type { FastifyInstance } from "fastify";

import { nowSeconds } from "../../lib/time.js";
import { aggregateStreams, statusWhere } from "../../repositories/streams.js";
import {
  RATE_LIMITED_RESPONSE_SCHEMA_ID,
  SERVER_ERROR_RESPONSE_SCHEMA_ID,
  STREAM_SUMMARY_RESPONSE_SCHEMA_ID,
} from "../../schema.js";

type StreamStatus = "pending" | "streaming" | "completed" | "cancelled";

const SUMMARY_STATUSES = ["pending", "streaming", "completed", "cancelled"] as const;

type SummaryEntry = { count: number; totalAmount: string; withdrawn: string };
type SummaryPayload = Record<StreamStatus, SummaryEntry>;

export function registerStreamSummaryRoute(app: FastifyInstance, summaryCacheTtlMs: number): void {
  let cachedSummary: { payload: SummaryPayload; createdAt: number } | null = null;
  // When a recomputation is already in-flight, all concurrent callers wait on
  // the same Promise instead of each running their own four aggregate queries.
  // A failed computation is never stored; the waiting callers all receive the
  // same rejection so no stale data leaks through.
  let inFlightSummary: Promise<SummaryPayload> | null = null;

  app.get(
    "/streams/summary",
    {
      schema: {
        summary: "Summarize streams by status",
        description:
          "Returns counts and exact amount totals for each lifecycle status across all indexed streams. " +
          "Totals are aggregated in the database over decimal columns, so they never lose precision.",
        tags: ["streams"],
        response: {
          200: { $ref: STREAM_SUMMARY_RESPONSE_SCHEMA_ID },
          429: { $ref: RATE_LIMITED_RESPONSE_SCHEMA_ID },
          500: { $ref: SERVER_ERROR_RESPONSE_SCHEMA_ID },
        },
      },
    },
    async (_request, reply) => {
      const requestTimeMs = Date.now();
      if (summaryCacheTtlMs > 0 && cachedSummary !== null) {
        const ageMs = requestTimeMs - cachedSummary.createdAt;
        if (ageMs >= 0 && ageMs < summaryCacheTtlMs) {
          const maxAgeSeconds = Math.floor((summaryCacheTtlMs - ageMs) / 1000);
          reply.header("Cache-Control", `public, max-age=${maxAgeSeconds}`);
          return cachedSummary.payload;
        }
      }

      // If another request is already computing the summary, share its result
      // instead of running a duplicate set of aggregate queries.
      if (inFlightSummary !== null) {
        const payload = await inFlightSummary;
        const ageMs = Date.now() - (cachedSummary?.createdAt ?? 0);
        const maxAgeSeconds = Math.max(0, Math.floor((summaryCacheTtlMs - ageMs) / 1000));
        reply.header("Cache-Control", `public, max-age=${maxAgeSeconds}`);
        return payload;
      }

      // This request is the first to notice the cache is stale — it owns the
      // computation. Build the promise, store it so concurrent arrivals can
      // attach, then await it ourselves.
      const compute = async (): Promise<SummaryPayload> => {
        const now = nowSeconds();
        const entries = await Promise.all(
          SUMMARY_STATUSES.map(async (status) => {
            const aggregate = await aggregateStreams(statusWhere(status, now));
            return [
              status,
              {
                count: aggregate.count,
                totalAmount: aggregate.totalAmount.toString(),
                withdrawn: aggregate.withdrawn.toString(),
              },
            ] as const;
          }),
        );
        return Object.fromEntries(entries) as SummaryPayload;
      };

      inFlightSummary = compute();
      try {
        const payload = await inFlightSummary;
        const createdAt = Date.now();
        if (summaryCacheTtlMs > 0) cachedSummary = { payload, createdAt };
        reply.header(
          "Cache-Control",
          `public, max-age=${Math.floor(summaryCacheTtlMs / 1000)}`,
        );
        return payload;
      } finally {
        // Always clear the in-flight slot so the next expiry triggers a fresh
        // computation. On failure this ensures no stale promise is reused.
        inFlightSummary = null;
      }
    },
  );
}
