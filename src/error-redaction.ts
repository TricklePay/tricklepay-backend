// ---------------------------------------------------------------------------
// Error redaction (#239).
//
// Raw RPC or database errors can carry connection strings, SQL fragments, or
// stack traces that must never reach a client. Outgoing messages are stripped
// of credential-bearing URLs and collapsed to their first line; the original
// error is preserved in the structured request log together with the request
// id for diagnosis.
//
// Structured error codes (#73): every API failure carries a stable,
// machine-readable `code` alongside the existing message and status, so
// clients can branch on the category without parsing human-readable text.
//
// Moving these transformations here makes each one easy to find, test, and
// reason about independently of server wiring.
// ---------------------------------------------------------------------------

/** Matches URLs with an authority that can embed credentials, e.g. postgres://user:pass@host/db */
const CREDENTIAL_URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@[^\s]*/g;

/**
 * Strips credential-bearing URLs from an error message and collapses
 * multi-line messages (stack traces) to their first line, so that sensitive
 * data never reaches API clients.
 */
export function redactErrorMessage(message: string): string {
  // Keep only the first line so stack traces and multi-line driver errors are
  // never echoed back to clients.
  const firstLine = message.split("\n")[0].trim();
  return firstLine.replace(CREDENTIAL_URL_PATTERN, "[redacted]");
}

// ---------------------------------------------------------------------------
// Structured error codes (#73).
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "REQUEST_ERROR"
  | "INTERNAL_SERVER_ERROR";

/**
 * Maps an HTTP status code to a stable, machine-readable error code string
 * that is included in every API error response body.
 */
export function errorCodeForStatus(statusCode: number): ApiErrorCode {
  if (statusCode === 400) return "VALIDATION_ERROR";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode >= 500) return "INTERNAL_SERVER_ERROR";
  return "REQUEST_ERROR";
}
