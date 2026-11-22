# Request Limits

The TricklePay backend enforces configurable request-body, query-string, and per-IP rate limits to protect against resource exhaustion and malformed requests. Response compression is configured separately.

## Overview

Three request limits are enforced:

1. **Body size limit**: Maximum request-body size in bytes.
2. **Query string limit**: Maximum number of characters in the URL query string.
3. **Request rate limit**: Maximum requests from one client IP in a fixed time window.

All three request limits are configurable via environment variables and have sensible defaults for typical API usage.

## Configuration

| Variable                      | Default            | Description                                                                                   |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `BODY_LIMIT`                  | `1048576` (1 MB)   | Maximum request body size in bytes                                                            |
| `QUERY_STRING_LIMIT`          | `2048` characters  | Maximum URL query string length (JavaScript string characters, after URL encoding)            |
| `RATE_LIMIT_MAX`              | `100`              | Maximum requests per client IP per rate-limit window                                          |
| `RATE_LIMIT_WINDOW_MS`        | `60000` (1 minute) | Duration of the fixed request rate-limit window in milliseconds                               |
| `RATE_LIMIT_ALLOWLIST`        | _(empty)_          | Comma-separated IPs or IPv4 CIDR blocks that bypass the rate limiter                          |
| `COMPRESSION_THRESHOLD_BYTES` | `1024` (1 KB)      | Minimum response size in bytes before it is compressed for clients that accept `gzip` or `br` |

### Setting Custom Limits

Add the variables to your `.env` file or export them in your environment:

```bash
# Allow up to 2MB request bodies
BODY_LIMIT=2097152

# Allow query strings up to 4,096 characters
QUERY_STRING_LIMIT=4096

# Allow 100 requests per client IP per minute
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000

# Exempt monitoring and SSR servers from rate limiting
RATE_LIMIT_ALLOWLIST=10.0.0.5,10.0.1.0/24
# Compress responses of 1KB or larger
COMPRESSION_THRESHOLD_BYTES=1024
```

**Note:** `BODY_LIMIT` and `COMPRESSION_THRESHOLD_BYTES` are measured in bytes. Common conversions:

- 1 KB = 1024 bytes
- 1 MB = 1048576 bytes

## Body Size Limit

The backend currently exposes GET routes only, so no route consumes a request body today. Fastify's configured body limit will apply when a body-bearing route is added; it is not currently an upload limit for an available endpoint.

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

When a route accepts a body, Fastify rejects payloads above `BODY_LIMIT` with `413 Payload Too Large` before that route's handler runs. There is no current route on which to demonstrate this behavior.

## Query String Limit

The query-string limit applies to the encoded portion of the URL after `?`, including parameter names, separators, and values. The server compares JavaScript string length (characters), not UTF-8 bytes. URL-encoded non-ASCII values are represented by ASCII percent-escape characters before this check.

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
# Build 100 valid uint64 stream IDs; the comma-separated value exceeds 2,048 characters.
ids=$(python3 -c 'print(",".join(["18446744073709551615"] * 100))')
curl --get --data-urlencode "ids=$ids" "http://localhost:3000/streams"

# Response: 400 Bad Request
# {"code":"VALIDATION_ERROR","error":"query string too long","requestId":"..."}
```

### What Counts Toward the Limit

Only the encoded query string itself is measured — the characters after `?`. The path, hostname, and protocol are not included.

## Request Rate Limit

Each client IP is allowed `RATE_LIMIT_MAX` requests during a fixed window of `RATE_LIMIT_WINDOW_MS`. The default is 100 requests per minute. When the limit is exceeded, the server returns HTTP 429 with a `Retry-After` header containing the remaining window duration in seconds, rounded up to the next whole second.

The `GET /health`, `GET /ready`, and `GET /metrics` endpoints are exempt from rate limiting and do not consume the client's request allowance. All other routes, including `/streams`, share the per-client IP limit.

The in-memory limiter is local to one server process, so clients behind a load balancer may receive a separate allowance from each instance. Fastify uses the direct peer address unless the proxy is listed in `TRUSTED_PROXIES`; only configure trusted proxies when they overwrite forwarded client-IP headers.

### Rate Limit Allowlist

Monitoring systems, server-side rendering hosts, and load testers often call the API at a high rate from known addresses. Set `RATE_LIMIT_ALLOWLIST` to a comma-separated list of IP addresses or IPv4 CIDR blocks to exempt those callers from counting and limiting entirely:

```bash
RATE_LIMIT_ALLOWLIST=10.0.0.5,10.0.1.0/24,127.0.0.1
```

Allowlisted addresses are validated at startup with the same rules as `TRUSTED_PROXIES` (plain IPv4/IPv6 addresses and IPv4 CIDR blocks). An invalid entry throws at config-load time so a typo never silently broadens or disables exemptions. The effective allowlist is shown in `print-config` output and the startup log line.

**Example:**

```
http://localhost:3000/streams?limit=50&offset=100
                              ^^^^^^^^^^^^^^^^^^^^^^^^^
                              This part is measured (24 characters)
```

## Response Compression

Response size is separate from the request limits above, but it is controlled by a related threshold. Large list responses (for example `/streams` with 100 streams) are mostly repetitive JSON, so the service registers `@fastify/compress` and compresses any response at or above `COMPRESSION_THRESHOLD_BYTES` (default `1024`) when the client advertises `gzip` or `br` via `Accept-Encoding`.

- **Above the threshold, client accepts gzip/brotli:** the response carries a `Content-Encoding` header (`gzip` or `br`) and a compressed body.
- **Below the threshold:** the response is sent uncompressed, because the encoding overhead would outweigh the saving for small bodies.
- **Client does not opt in:** the response is sent uncompressed regardless of size.

Compression cuts transfer size for clients on metered or slow links. The threshold is configurable via `COMPRESSION_THRESHOLD_BYTES`; lower it to compress more responses, or raise it if CPU cost on the server matters more than transfer size.

## Why These Limits Exist

1. **Body limit:** Prevents memory exhaustion from unbounded request payloads. Without a cap, a malicious or misconfigured client could send gigabytes of data, exhausting memory or disk.

2. **Query string limit:** Prevents abuse via extremely long URLs. Web servers and proxies often have their own URL length limits (commonly 4KB-8KB), and excessively long query strings can bypass caching or cause parsing issues.

## Debugging Limit Errors

If a legitimate request is rejected:

1. **Check the actual size:** For bodies, check `Content-Length`. For query strings, count the encoded characters after `?`.
2. **Reduce the URL:** Paginate large lists, omit unnecessary filters, or split a long ID lookup across requests.
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
The request ID in the error response matches the `reqId` field in Pino's structured output on stdout. For the local Docker API service, search its process output by that ID:

```bash
# Find the rejected request in the API container's stdout
docker compose logs --no-color api | grep 'req-1234'
```

## Implementation Details

- **Body limit:** Enforced by Fastify's built-in `bodyLimit` option, which reads from `config.bodyLimit`.
- **Query string limit:** Enforced by a custom `onRequest` hook in `src/server.ts` that measures the raw query string before route handling or database access.
- **Compression threshold:** Enforced by `@fastify/compress`, registered in `src/server.ts` with `threshold` read from `config.compressionThresholdBytes`.

See `src/config.ts` for the default values and `src/server.ts` for the rejection logic.

## Common Scenarios

### Scenario 1: Large Stream List Query

**Problem:** A client requests `/streams` with many filters, building a very long query string.

**Solution:**

- Use cursor-based pagination and smaller pages to keep requests short.
- Split an `ids` lookup across multiple requests; `/streams` accepts at most 100 IDs per request.
- Increase `QUERY_STRING_LIMIT` only when the longer URL is expected by your deployment.

The API currently has no body-bearing route, so clients cannot submit a bulk upload to this service. If a future route accepts request bodies, document that route's behavior before recommending `BODY_LIMIT` changes.

## Further Reading

- [Fastify Body Limit Documentation](https://fastify.dev/docs/latest/Reference/Server/#bodylimit)
- [RFC 7230 Section 3.1.1: Request Line Length](https://datatracker.ietf.org/doc/html/rfc7230#section-3.1.1)
