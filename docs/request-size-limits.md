# Request Limits

The TricklePay backend enforces configurable limits on incoming HTTP requests to protect against resource exhaustion and malformed payloads. This document describes the limits, their defaults, and the behavior when they are exceeded.

## Overview

Three separate limits are enforced:

1. **Body size limit**: Maximum size of the request body (POST/PUT payloads).
2. **Query string limit**: Maximum length of the URL query string portion.
3. **Request rate limit**: Maximum requests from one client IP in a fixed time window.

Both limits are configurable via environment variables and have sensible defaults for typical API usage.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BODY_LIMIT` | `1048576` (1 MB) | Maximum request body size in bytes |
| `QUERY_STRING_LIMIT` | `2048` (2 KB) | Maximum URL query string length in bytes |
| `RATE_LIMIT_MAX` | `100` | Maximum requests per client IP per rate-limit window |
| `RATE_LIMIT_WINDOW_MS` | `60000` (1 minute) | Duration of the fixed request rate-limit window in milliseconds |

### Setting Custom Limits

Add the variables to your `.env` file or export them in your environment:

```bash
# Allow up to 2MB request bodies
BODY_LIMIT=2097152

# Allow up to 4KB query strings
QUERY_STRING_LIMIT=4096

# Allow 100 requests per client IP per minute
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
```

**Note:** Values are in bytes. Common conversions:
- 1 KB = 1024 bytes
- 1 MB = 1048576 bytes

## Body Size Limit

The body limit applies to the entire request payload for POST, PUT, and PATCH requests. This includes JSON payloads, form data, and file uploads.

### When the Limit is Exceeded

**Status Code:** `413 Payload Too Large`

**Response:**
```json
{
  "code": "REQUEST_ERROR",
  "error": "Payload too large",
  "requestId": "req-1234"
}
```

**Behavior:** The request is rejected before the full body is read. The connection is closed and no application logic runs.

### Example

```bash
# Generate a 2MB payload (exceeds default 1MB limit)
dd if=/dev/zero bs=1M count=2 | curl -X POST \
  -H "Content-Type: application/octet-stream" \
  --data-binary @- \
  http://localhost:3000/some-endpoint

# Response: 413 Payload Too Large
```

## Query String Limit

The query string limit applies to the portion of the URL after the `?` character, including all parameters and their values.

### When the Limit is Exceeded

**Status Code:** `400 Bad Request`

**Response:**
```json
{
  "code": "VALIDATION_ERROR",
  "error": "query string too long",
  "requestId": "req-1234"
}
```

**Behavior:** The request is rejected in the `onRequest` hook before routing. No endpoint logic runs.

### Example

```bash
# Generate a query string exceeding 2KB
curl "http://localhost:3000/streams?$(python3 -c 'print("x" * 3000)')"

# Response: 400 Bad Request
# {"code":"VALIDATION_ERROR","error":"query string too long","requestId":"..."}
```

### What Counts Toward the Limit

Only the query string itself is measured — the characters after the `?` in the URL. The path, hostname, and protocol are not included.

## Request Rate Limit

Each client IP is allowed `RATE_LIMIT_MAX` requests during a fixed window of `RATE_LIMIT_WINDOW_MS`. The default is 100 requests per minute. When the limit is exceeded, the server returns HTTP 429 with a `Retry-After` header containing the remaining window duration in seconds, rounded up to the next whole second.

The in-memory limiter is local to one server process, so clients behind a load balancer may receive a separate allowance from each instance. Fastify uses the direct peer address unless the proxy is listed in `TRUSTED_PROXIES`; only configure trusted proxies when they overwrite forwarded client-IP headers.

**Example:**
```
http://localhost:3000/streams?limit=50&offset=100
                              ^^^^^^^^^^^^^^^^^^^^^^^^^
                              This part is measured (24 bytes)
```

## Why These Limits Exist

1. **Body limit:** Prevents memory exhaustion from unbounded request payloads. Without a cap, a malicious or misconfigured client could send gigabytes of data, exhausting memory or disk.

2. **Query string limit:** Prevents abuse via extremely long URLs. Web servers and proxies often have their own URL length limits (commonly 4KB-8KB), and excessively long query strings can bypass caching or cause parsing issues.

## Debugging Limit Errors

If a legitimate request is rejected:

1. **Check the actual size:** For bodies, check `Content-Length` header. For query strings, measure the encoded URL.
2. **Reduce the payload:** Paginate large lists, omit unnecessary fields, or use POST instead of GET with query parameters.
3. **Increase the limit:** If the size is justified, raise `BODY_LIMIT` or `QUERY_STRING_LIMIT` in your configuration.

### Checking Request Size

**Body size (client-side):**
```bash
echo '{"key":"value"}' | wc -c
# Output: byte count
```

**Query string length (client-side):**
```bash
echo "limit=50&offset=100" | wc -c
# Output: byte count
```

**Inspecting rejected requests (server logs):**
The request ID in the error response matches the `reqId` field in structured logs. Search for that ID to see the full request context:

```bash
# Find the rejected request in logs
grep "req-1234" logs/app.log
```

## Implementation Details

- **Body limit:** Enforced by Fastify's built-in `bodyLimit` option, which reads from `config.bodyLimit`.
- **Query string limit:** Enforced by a custom `onRequest` hook in `src/server.ts` that measures the raw query string length before parsing.

See `src/config.ts` for the default values and `src/server.ts` for the rejection logic.

## Common Scenarios

### Scenario 1: Large Stream List Query

**Problem:** A client requests `/streams` with many filters, building a very long query string.

**Solution:**
- Use cursor-based pagination instead of offset-based pagination (cursors are typically shorter)
- POST the filters in a request body instead of a query string
- Increase `QUERY_STRING_LIMIT` if the size is legitimate

### Scenario 2: Bulk Upload

**Problem:** A client tries to POST a large JSON array of records.

**Solution:**
- Split the batch into smaller chunks
- Increase `BODY_LIMIT` if the server has sufficient memory
- Use streaming uploads if supported

## Further Reading

- [Fastify Body Limit Documentation](https://fastify.dev/docs/latest/Reference/Server/#bodylimit)
- [RFC 7230 Section 3.1.1: Request Line Length](https://datatracker.ietf.org/doc/html/rfc7230#section-3.1.1)
