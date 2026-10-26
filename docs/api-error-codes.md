# API Error Codes

Every API failure returned by the TricklePay backend includes a stable, machine-readable `code` alongside a human-readable message. This allows client developers to build robust error handling and branch on error categories without having to parse human-readable text.

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
- `error`: A human-readable error message. For `INTERNAL_SERVER_ERROR`, raw error details (stack traces, SQL fragments) are redacted and a generic `"internal server error"` message is returned instead.
- `requestId`: The request ID associated with the error, useful for correlating client errors with server-side logs.

## Defined Error Codes

The table below lists every HTTP status code the service can return and the `code` it maps to.

| HTTP Status | Code | When it occurs |
|-------------|------|----------------|
| `400` | `VALIDATION_ERROR` | Invalid or malformed request — missing required fields, bad parameter values, repeated query parameters, or a query string that exceeds the configured length limit. |
| `404` | `NOT_FOUND` | The requested resource or route cannot be found. |
| `413` | `REQUEST_ERROR` | The request body exceeds the configured `BODY_LIMIT` (default 1 MiB). |
| `429` | `RATE_LIMITED` | The client has exceeded the configured request rate limit. The response includes a `Retry-After` header with the number of seconds until the window resets. Clients should back off and retry after that interval. |
| `500` | `INTERNAL_SERVER_ERROR` | An unexpected server-side error. The original error is logged internally with the request ID; the client receives a safe, redacted message. |

### Example: 400 Validation Error

```bash
curl -s http://localhost:3000/streams/invalid | jq
```

```json
{
  "code": "VALIDATION_ERROR",
  "error": "invalid stream id",
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

### Example: 404 Not Found

```bash
curl -s http://localhost:3000/streams/99999999 | jq
```

```json
{
  "code": "NOT_FOUND",
  "error": "stream not found",
  "requestId": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
}
```

### Example: 429 Rate Limited

```bash
curl -s -D - http://localhost:3000/streams | head -20
```

```
HTTP/1.1 429 Too Many Requests
Retry-After: 42
x-request-id: c3d4e5f6-a7b8-9012-cdef-123456789012
```

```json
{
  "code": "RATE_LIMITED",
  "error": "rate limit exceeded",
  "requestId": "c3d4e5f6-a7b8-9012-cdef-123456789012"
}
```

The `Retry-After` value is the number of seconds remaining in the current rate-limit window. Wait that long before retrying rather than branching on the HTTP status code alone.

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
