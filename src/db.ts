import { PrismaClient } from "@prisma/client";

// A single Prisma client shared across the process. Each new client opens its
// own connection pool, so every module imports this one instance rather than
// constructing its own.
export const prisma = new PrismaClient();

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
 * `timeoutMs` has elapsed, whichever happens first.
 *
 * Prisma exposes no per-query abort, so the underlying query is not cancelled;
 * this stops the request from waiting on it. The timer is always cleared so a
 * fast query never leaves a pending handle behind.
 */
export async function withQueryTimeout<T>(
  operation: Promise<T>,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueryTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export async function checkHealth(timeoutMs = 5000): Promise<{ status: "up" | "down"; error?: string }> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return { status: "up" };
  } catch (err: unknown) {
    const error = err instanceof Error && err.message === "timeout" ? "timeout" : "database unavailable";
    return { status: "down", error };
  }
}
