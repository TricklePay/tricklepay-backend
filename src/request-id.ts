// ---------------------------------------------------------------------------
// Request ids.
//
// Every request gets an id that appears as the `reqId` field in Fastify's
// structured request logs and is echoed back in the `x-request-id` response
// header and error bodies, so a client report can be matched to its log lines.
// A caller may supply its own id through `x-request-id`, but arbitrary header
// values are not trusted: an id is forwarded only when it is short and made of
// safe characters; anything else (or nothing) yields a fresh UUID.
//
// The sanitisation rules live here, separate from the server wiring, so they
// can be unit-tested directly and the server file stays focused on setup.
// ---------------------------------------------------------------------------

export const REQUEST_ID_HEADER = "x-request-id";

export const MAX_REQUEST_ID_LENGTH = 64;

/**
 * An id must start with an alphanumeric character and otherwise contain only
 * letters, digits, dots, underscores, and hyphens. This keeps forwarded ids
 * safe for log lines and response headers while still allowing common tracing
 * formats (e.g. `client-trace-42`, `abcdef01-2345`).
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Returns the client-supplied request id when it is safe to forward, or
 * `undefined` when the caller should get a generated id instead. Non-string
 * values, oversized values, and values with unsafe characters are rejected.
 */
export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_REQUEST_ID_LENGTH) return undefined;
  return REQUEST_ID_PATTERN.test(value) ? value : undefined;
}
