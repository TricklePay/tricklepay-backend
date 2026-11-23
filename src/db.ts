import { PrismaClient } from "@prisma/client";

import { requestSignalStorage } from "./lib/request-context.js";
import { databaseQueryDuration, repositoryQueryDuration } from "./metrics.js";

// A single Prisma client shared across the process. Each new client opens its
// own connection pool, so every module imports this one instance rather than
// constructing its own.
export const prisma = new PrismaClient({
  log: [{ emit: "event", level: "query" }],
});

prisma.$on("query", (event) => {
  databaseQueryDuration.observe({}, event.duration);
});

// ---------------------------------------------------------------------------
// Bounded reads (#221)
//
// A database call made while serving a request needs an upper bound: without
// one a single slow query holds a pooled connection and the client waits
// indefinitely. Every request-scoped read runs through `withQueryTimeout`, so a
// query that exceeds its bound fails fast and the route returns a 500 instead
// of hanging. Indexer writes are not wrapped — they run off the request path
// and may legitimately take longer.
// ---------------------------------------------------------------------------

/** Default upper bound for a request-scoped database read. */
export const DEFAULT_QUERY_TIMEOUT_MS = 5000;

/** Thrown when a request-scoped database read exceeds its bound. */
export class QueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`database query exceeded its ${timeoutMs}ms bound`);
    this.name = "QueryTimeoutError";
  }
}

/**
 * Resolves with `operation`, or rejects with {@link QueryTimeoutError} once
 * `timeoutMs` has elapsed or when the request's AbortSignal is cancelled (#675),
 * whichever happens first.
 *
 * When an AbortSignal cancels, the wait on the database query terminates immediately,
 * freeing the handler from racing the timed-out client response. The timer is always
 * cleared so a fast query never leaves a pending handle behind.
 */
export async function withQueryTimeout<T>(
  operation: Promise<T>,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  const activeSignal = signal ?? requestSignalStorage.getStore();
  if (activeSignal?.aborted) {
    throw activeSignal.reason ?? new Error("request aborted");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueryTimeoutError(timeoutMs)), timeoutMs);
        if (activeSignal) {
          onAbort = () => reject(activeSignal.reason ?? new Error("request aborted"));
          activeSignal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (activeSignal && onAbort) activeSignal.removeEventListener("abort", onAbort);
  }
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export async function checkHealth(timeoutMs = 5000): Promise<{ status: "up" | "down"; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return { status: "up" };
  } catch (err: unknown) {
    const error = err instanceof Error && err.message === "timeout" ? "timeout" : "database unavailable";
    return { status: "down", error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Repository function instrumentation
//
// Wraps repository functions to record their execution duration in the
// repositoryQueryDuration histogram. This provides observability into which
// repository operations are slow and where optimization is needed.
// ---------------------------------------------------------------------------

/**
 * Wraps a repository function to measure its duration and record it in the
 * repositoryQueryDuration histogram with the function name as a label.
 *
 * Usage:
 *   export async function getStream(...): Promise<Stream | null> {
 *     return measureRepositoryCall("getStream", () =>
 *       withQueryTimeout(prisma.stream.findUnique({ where: { streamId } }))
 *     );
 *   }
 */
export async function measureRepositoryCall<T>(
  functionName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await operation();
  } finally {
    const duration = Date.now() - start;
    repositoryQueryDuration.observe({ function: functionName }, duration);
  }
}
