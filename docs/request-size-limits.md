# Request Limits

The TricklePay backend enforces configurable limits on incoming HTTP requests to protect against resource exhaustion and malformed payloads. This document describes the limits, their defaults, and the behavior when they are exceeded.

## Overview

Three separate limits are enforced:

1. **Body size limit**: Maximum request-body size enforced by Fastify. This is a safeguard for future body-bearing routes; the current service exposes only GET API routes.
2. **Query string limit**: Maximum length of the URL query string portion.
3. **Request rate limit**: Maximum requests from one client IP in a fixed time window.

All three limits are configurable via the four environment variables below and have defaults for typical API usage.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BODY_LIMIT` | `1048576` (1 MB) | Maximum request body size in bytes |
| `QUERY_STRING_LIMIT` | `2048` | Maximum raw URL query string length (JavaScript string length) |
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

**Units:** `BODY_LIMIT` is in bytes; `QUERY_STRING_LIMIT` is checked against the raw query string's JavaScript `.length` (UTF-16 code units, not a byte count). `RATE_LIMIT_MAX` is a request count and `RATE_LIMIT_WINDOW_MS` is in milliseconds. For body sizes, 1 KiB = 1024 bytes and 1 MiB = 1048576 bytes.

## Body Size Limit

Fastify configures a maximum request-body size using `config.bodyLimit`. **The current TricklePay API exposes GET routes only**, so no existing API endpoint accepts JSON uploads, file uploads, or POST/PUT/PATCH bodies. This limit is in place for any future body-bearing route; it is not a currently usable upload limit.

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

**Behavior:** Fastify rejects an oversized body while parsing it, before a body-bearing route handler runs. This is a description of the server safeguard, **not a request you can reproduce against the current GET-only API**. An unsupported POST request should not be used as a body-limit test.

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
# Query the real GET /streams route with over 2,048 query characters.
curl -i "http://localhost:3000/streams?$(python3 -c 'print("filter=" + "x" * 3000)')"

# Response: 400 Bad Request
# {"code":"VALIDATION_ERROR","error":"query string too long","requestId":"..."}
```

### What Counts Toward the Limit

Only the portion after the first `?` in the raw request URL is measured; the path, hostname, and protocol are excluded. The server uses JavaScript `rawQuery.length`, so the limit counts UTF-16 code units of the raw query string rather than the decoded parameters or their byte size.

## Request Rate Limit

Each client IP is allowed `RATE_LIMIT_MAX` requests during a fixed window of `RATE_LIMIT_WINDOW_MS`. The default is 100 requests per minute. When the limit is exceeded, the server returns HTTP 429 with a `Retry-After` header containing the remaining window duration in seconds, rounded up to the next whole second.

The in-memory limiter is local to one server process, so clients behind a load balancer may receive a separate allowance from each instance. Fastify uses the direct peer address unless the proxy is listed in `TRUSTED_PROXIES`; only configure trusted proxies when they overwrite forwarded client-IP headers.

**Example:**
```
http://localhost:3000/streams?limit=50&offset=100
                              ^^^^^^^^^^^^^^^^^^^^^^^^^
                              This part is measured (query characters, not bytes)
```

## Why These Limits Exist

1. **Body limit:** Guards against unbounded request bodies if the service later adds body-bearing endpoints. No current API route accepts them.

2. **Query string limit:** Prevents abuse via extremely long URLs. Web servers and proxies often have their own URL length limits (commonly 4KB-8KB), and excessively long query strings can bypass caching or cause parsing issues.

## Debugging Limit Errors

If a legitimate request is rejected:

1. **Check the request:** For GET requests, inspect only the part of the raw URL after `?`; its JavaScript string length must fit `QUERY_STRING_LIMIT`. The body limit applies to no current route.
2. **Reduce the query:** Use supported pagination parameters (`limit`, `offset` or `cursor`), avoid oversized filters, and remove unnecessary query parameters. The API does not offer a POST alternative.
3. **Adjust the appropriate limit:** If the query is valid and legitimately needs more space, raise `QUERY_STRING_LIMIT`; changes to `BODY_LIMIT` do not affect GET query strings.

### Checking Request Size

**Query string length (client-side):**
```bash
# Match the server's JavaScript string-length check for this ASCII query.
node -e 'console.log("limit=50&offset=100".length)'
# Output: 19
```

The check uses the **raw** query string (including percent-encoded characters). The numeric result above is for the ASCII example and is not a body byte count.

**Inspecting rejected requests (server logs):**
The request ID in the error response matches the `reqId` field in structured logs. Search for that ID to see the full request context:

```bash
# Pino writes structured logs to stdout, not logs/app.log.
# Example when the server output has been redirected to a file:
grep '"reqId":"req-1234"' server.stdout.log

# For a containerized deployment:
docker compose logs api | grep '"reqId":"req-1234"'
```

## Implementation Details

- **Body limit:** Enforced by Fastify's built-in `bodyLimit` option, which reads from `config.bodyLimit` (no current route consumes a body).
- **Query string limit:** Enforced by a custom `onRequest` hook in `src/server.ts`, using `rawQuery.length` before route dispatch.
- **Rate limit:** Enforced by the per-IP fixed-window `onRequest` hook in `src/server.ts`, returning HTTP 429 and a `Retry-After` header.

See `src/config.ts` for the default values and `src/server.ts` for the rejection logic.

## Common Scenarios

### Scenario 1: Large Stream List Query

**Problem:** A client requests `GET /streams` with an overly long query string.

**Solution:**
- Keep supported pagination parameters (`limit`, `offset`, `cursor`) and remove unnecessary filters.
- If the encoded query is still legitimately longer than the configured limit, raise `QUERY_STRING_LIMIT`.
- Do not POST the filters; this API does not implement a POST query route.

### Scenario 2: Rate Limit on Repeated Stream Reads

**Problem:** A client repeatedly requests `GET /streams?limit=50`, exceeding the fixed per-IP request window.

**Solution:**
- Respect the HTTP 429 `Retry-After` header before retrying.
- Reduce polling frequency, batch pagination efficiently, or adjust `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` for authorized workloads.

## Further Reading

- [Fastify Body Limit Documentation](https://fastify.dev/docs/latest/Reference/Server/#bodylimit)
- [RFC 7230 Section 3.1.1: Request Line Length](https://datatracker.ietf.org/doc/html/rfc7230#section-3.1.1)
