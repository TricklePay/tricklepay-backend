# Rate Limiting

The TricklePay backend implements per-route-group rate limiting to protect the service from abuse and ensure fair resource allocation. Different endpoint groups have different limits based on their computational cost.

## Overview

Rate limits are enforced per client IP address using a fixed-window algorithm. Each route group maintains its own independent bucket, so exhausting the limit on expensive endpoints does not affect your ability to call cheaper ones.

## Route Groups

Requests are classified into four groups based on their path:

| Group | Description | Example Endpoints |
|-------|-------------|-------------------|
| **detail** | Single resource reads (cheap) | `GET /v1/streams/:id`, `GET /v1/streams/:id/events`, `GET /v1/streams/:id/schedule` |
| **list** | Paginated list endpoints (moderate) | `GET /v1/streams`, `GET /v1/tokens` |
| **summary** | Aggregation and summary endpoints (expensive) | `GET /v1/streams/summary`, `GET /v1/accounts/:address/summary` |
| **default** | All other endpoints | `GET /v1/`, `GET /v1/status` |

## Default Limits

The default rate limits per group (per IP, per window):

| Group | Requests | Window | Environment Variables |
|-------|----------|--------|----------------------|
| **detail** | 200 | 60 seconds | `RATE_LIMIT_DETAIL_MAX`, `RATE_LIMIT_DETAIL_WINDOW_MS` |
| **list** | 50 | 60 seconds | `RATE_LIMIT_LIST_MAX`, `RATE_LIMIT_LIST_WINDOW_MS` |
| **summary** | 20 | 60 seconds | `RATE_LIMIT_SUMMARY_MAX`, `RATE_LIMIT_SUMMARY_WINDOW_MS` |
| **default** | 100 | 60 seconds | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |

## Exempt Endpoints

The following endpoints are **never rate limited** to ensure liveness and observability remain available:

- `GET /health`, `GET /v1/health` — Liveness check
- `GET /ready`, `GET /v1/ready` — Readiness check
- `GET /metrics`, `GET /v1/metrics` — Prometheus metrics

## Configuration

### Setting Custom Limits

Add environment variables to your `.env` file or export them:

```bash
# Detail endpoints (single stream reads)
RATE_LIMIT_DETAIL_MAX=300
RATE_LIMIT_DETAIL_WINDOW_MS=60000

# List endpoints (paginated queries)
RATE_LIMIT_LIST_MAX=75
RATE_LIMIT_LIST_WINDOW_MS=60000

# Summary endpoints (expensive aggregations)
RATE_LIMIT_SUMMARY_MAX=10
RATE_LIMIT_SUMMARY_WINDOW_MS=60000

# Default bucket (everything else)
RATE_LIMIT_MAX=150
RATE_LIMIT_WINDOW_MS=60000
```

### Allowlist

You can exempt specific IP addresses from rate limiting entirely:

```bash
# Comma-separated list of IP addresses
RATE_LIMIT_ALLOWLIST=10.0.0.1,10.0.0.2,192.168.1.0/24
```

Allowlisted addresses bypass all rate limit checks.

## Rate Limit Response

When a rate limit is exceeded, the API returns:

**Status Code:** `429 Too Many Requests`

**Headers:**
- `Retry-After`: Seconds until the window resets

**Response Body:**
```json
{
  "code": "RATE_LIMITED",
  "error": "rate limit exceeded",
  "group": "summary",
  "requestId": "req-1234"
}
```

The `group` field identifies which rate limit bucket was exceeded, helping clients understand which endpoint category to throttle.

## Fixed Window Algorithm

Each route group uses a fixed-window counter:

1. When a client makes their first request, a window opens for that group
2. The window lasts for the configured duration (e.g., 60 seconds)
3. Each request increments the counter for that group
4. When the limit is reached, further requests return `429`
5. When the window expires, the counter resets to zero

**Important:** Windows are **per-IP, per-group**. A client can have up to 4 active windows simultaneously (one for each group).

## Example Scenarios

### Scenario 1: Detail vs. Summary

A client makes:
- 150 requests to `GET /v1/streams/:id` (detail group)
- 15 requests to `GET /v1/streams/summary` (summary group)

**Result:**
- Detail requests: 150/200 consumed, still within limit
- Summary requests: 15/20 consumed, still within limit
- Both succeed because each group has its own bucket

### Scenario 2: Summary Exhaustion

A client makes:
- 25 requests to `GET /v1/streams/summary` (summary group limit: 20)

**Result:**
- First 20 requests succeed
- Requests 21-25 return `429 Too Many Requests` with `group: "summary"`
- Detail and list requests are unaffected and can still be made

### Scenario 3: Multiple Groups

A client exhausts the summary limit (20/20), then makes:
- `GET /v1/streams` → Succeeds (list group: 1/50)
- `GET /v1/streams/:id` → Succeeds (detail group: 1/200)
- `GET /v1/streams/summary` → Fails with `429` (summary group: 20/20)

## Monitoring

Rate limit metrics are exposed at `/metrics`:

```promql
# Rate limit rejections by group
rate(tricklepay_http_requests_total{status="429"}[5m])
```

Check the `group` label in 429 response bodies to identify which endpoints are being throttled.

## Best Practices

1. **Use detail endpoints when possible**: They have the highest limits (200/min by default)
2. **Cache summary results**: Summary endpoints are expensive and have low limits (20/min)
3. **Implement exponential backoff**: When you receive a `429`, honor the `Retry-After` header
4. **Distribute load**: If you need high throughput, use multiple client IPs or request an allowlist entry
5. **Monitor your usage**: Track `429` responses and adjust your request patterns accordingly

## Troubleshooting

### Issue: Getting 429 on summary endpoints

**Cause:** Summary endpoints perform database aggregations and are limited to 20 requests/minute by default.

**Solutions:**
- Cache the results client-side
- Reduce polling frequency
- Use more specific queries (filter by sender/recipient/token)
- Request a higher limit via `RATE_LIMIT_SUMMARY_MAX`

### Issue: Getting 429 on list endpoints

**Cause:** List endpoints have moderate limits (50/min default).

**Solutions:**
- Use cursor-based pagination instead of polling
- Increase page size with the `limit` parameter (up to 100)
- Use the `fields` parameter to reduce payload size
- Request a higher limit via `RATE_LIMIT_LIST_MAX`

## Further Reading

- [Configuration Documentation](../README.md#configuration)
- [API Error Codes](api-error-codes.md)
- [Request Size Limits](request-size-limits.md)
