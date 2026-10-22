# API Error Codes

Every API failure returned by the TricklePay backend includes a stable, machine-readable `code` alongside a human-readable message. This allows client developers to build robust error handling and branch on error categories without having to parse human-readable text.

## Log Redaction Behaviour

Error messages sent to clients are redacted to prevent leaking sensitive information such as database connection strings, internal hostnames, or stack traces. The full, unredacted error remains in the server log for operator diagnosis.

### What is Redacted

The following information is stripped from error messages before they reach the client:

1. **Credential-bearing URLs**: Any URL containing embedded credentials (e.g., `postgres://user:password@host/db`) is replaced with `[redacted]`.
2. **Multi-line errors**: Stack traces and multi-line error messages are collapsed to their first line only. Subsequent lines (which often contain file paths, function names, and internal implementation details) are discarded.
3. **Internal server errors**: When the HTTP status is 500 or above, the client receives the generic message `"internal server error"` regardless of the original error text.

### What Remains in the Server Log

The original, unredacted error — including the full stack trace, connection string, SQL fragment, or any other diagnostic detail — is preserved in the structured server log. Every error log entry includes the `reqId` field, which matches the `requestId` returned to the client. Use this request ID to correlate a client-reported failure with its detailed server-side log entry.

### Example

**Original error (server-side):**
```
Invalid prisma.$queryRaw invocation:
Connection failed: postgres://tricklepay:s3cret@db.internal:5432/tricklepay
    at TCP.connect (node:net:123:45)
    at Database.query (/app/db.ts:67:12)
```

**Redacted message (client response):**
```json
{
  "code": "INTERNAL_SERVER_ERROR",
  "error": "internal server error",
  "requestId": "req-abc123"
}
```

**Server log entry (for operator diagnosis):**
```json
{
  "level": 50,
  "time": 1234567890123,
  "reqId": "req-abc123",
  "err": {
    "type": "Error",
    "message": "Invalid prisma.$queryRaw invocation: Connection failed: postgres://tricklepay:s3cret@db.internal:5432/tricklepay",
    "stack": "Error: Invalid prisma.$queryRaw invocation...\n    at TCP.connect (node:net:123:45)\n    at Database.query (/app/db.ts:67:12)"
  },
  "msg": "request failed"
}
```

### Security Rationale

Exposing raw database or RPC errors to clients can leak:
- Database credentials embedded in connection strings
- Internal hostnames and network topology
- Software versions and library paths from stack traces
- SQL query structure and table names

By redacting client responses while preserving full details server-side, operators retain the diagnostic information needed to fix failures without exposing sensitive infrastructure details to external callers.

## Response Shape

Error responses are returned as a JSON object with the following structure:

```json
{
  "code": "NOT_FOUND",
  "error": "Route GET /missing-path not found",
  "requestId": "client-trace-42"
}
```

- `code`: The stable error code (see below).
- `error`: A human-readable error message. Note that for `INTERNAL_SERVER_ERROR`, original raw error details (such as stack traces or SQL fragments) are redacted for security, and a generic "internal server error" message is returned instead.
- `requestId`: The request ID associated with the error (useful for correlating client errors with server-side logs).

## Defined Error Codes

The backend defines and returns the following error codes based on the HTTP status code of the failure:

- `VALIDATION_ERROR`
  - **Returned When:** The request is invalid or malformed (HTTP status `400`). This could be due to missing required fields, invalid parameters, or malformed request bodies.
- `NOT_FOUND`
  - **Returned When:** The requested resource or route cannot be found (HTTP status `404`).
- `RATE_LIMITED`
  - **Returned When:** The client has exceeded the configured request rate limit (HTTP status `429`). The response includes a `Retry-After` header with the number of seconds until the window resets. Clients should back off and retry after that interval rather than branching on the HTTP status code alone.
- `REQUEST_ERROR`
  - **Returned When:** The request fails with any other 4xx client error (e.g., HTTP statuses `401`, `403`, `409`, etc.) that is not explicitly a `VALIDATION_ERROR`, `NOT_FOUND`, or `RATE_LIMITED`.
- `INTERNAL_SERVER_ERROR`
  - **Returned When:** An unexpected server-side error occurs (HTTP status `500` and above). The original error message is logged internally with the request ID, but the client receives a safe, redacted message.
