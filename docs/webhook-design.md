# Webhook Notifications Design

## Overview

This design adds webhook support for stream events, enabling integrators (payroll tools, notification services) to receive real-time notifications when streams are created, withdrawn from, or cancelled. This eliminates the need for API polling and provides push-based integration.

## Goals

1. Deliver event notifications to registered HTTP endpoints
2. Secure webhook payloads with HMAC signatures
3. Implement reliable delivery with automatic retries and exponential backoff
4. Prevent webhooks from targeting private network addresses (SSRF protection)
5. Record all delivery attempts for debugging and monitoring
6. Support webhook registration, management, and testing

## High-Level Architecture

```
Indexer Event Application
         ↓
  Webhook Dispatcher
         ↓
  Delivery Queue (in-process)
         ↓
  HTTP POST to Webhook URL
         ↓
  Record Delivery Attempt
         ↓
  Retry on Failure (exponential backoff)
```

## Webhook Registration

### Registration Model

Webhooks are registered via API and stored in the database:

```typescript
interface WebhookRegistration {
  id: string;                    // UUID
  url: string;                   // Target HTTPS endpoint
  events: WebhookEvent[];        // Event types to subscribe to
  secret: string;                // HMAC signing secret (generated)
  enabled: boolean;              // Active/paused state
  metadata?: Record<string, string>; // User-defined key-value pairs
  createdAt: Date;
  updatedAt: Date;
}

type WebhookEvent = 'stream.created' | 'stream.withdrawn' | 'stream.cancelled' | '*';
```

### Registration Endpoint

**POST /webhooks**

Create a new webhook registration:

```http
POST /webhooks HTTP/1.1
Content-Type: application/json
Authorization: Bearer <API_TOKEN>

{
  "url": "https://integrator.example.com/webhooks/tricklepay",
  "events": ["stream.created", "stream.withdrawn"],
  "metadata": {
    "environment": "production",
    "team": "payroll"
  }
}
```

**Response:**

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "id": "wh_1a2b3c4d5e6f",
  "url": "https://integrator.example.com/webhooks/tricklepay",
  "events": ["stream.created", "stream.withdrawn"],
  "secret": "whsec_abcdef123456...",
  "enabled": true,
  "metadata": {
    "environment": "production",
    "team": "payroll"
  },
  "createdAt": "2026-11-23T10:30:00.000Z",
  "updatedAt": "2026-11-23T10:30:00.000Z"
}
```

**URL Validation:**
- Must be HTTPS (no plain HTTP except localhost for testing)
- Must not target private/internal network ranges (SSRF protection)
- Must be a well-formed URL with valid domain

**Event Types:**
- `stream.created`: Fired when a new stream is created on-chain
- `stream.withdrawn`: Fired when funds are withdrawn from a stream
- `stream.cancelled`: Fired when a stream is cancelled
- `*`: Wildcard to receive all event types

### Management Endpoints

**GET /webhooks**  
List all webhook registrations (paginated)

**GET /webhooks/:id**  
Get a specific webhook registration

**PATCH /webhooks/:id**  
Update webhook configuration (url, events, enabled, metadata)

**DELETE /webhooks/:id**  
Delete a webhook registration (also cancels pending deliveries)

**POST /webhooks/:id/test**  
Send a test payload to verify endpoint is reachable

## Webhook Payload Format

### Payload Structure

All webhook payloads follow this structure:

```typescript
interface WebhookPayload {
  id: string;                    // Unique delivery ID (UUID)
  type: WebhookEvent;            // Event type
  createdAt: string;             // ISO 8601 timestamp
  data: StreamEventData;         // Event-specific data
  metadata: {
    webhookId: string;           // Registration ID
    attemptNumber: number;       // Delivery attempt (1-indexed)
    contractId: string;          // Source contract
  };
}
```

### Event-Specific Data

**stream.created**

```json
{
  "id": "whdlv_abc123",
  "type": "stream.created",
  "createdAt": "2026-11-23T10:30:00.000Z",
  "data": {
    "streamId": "12345",
    "sender": "GABC...",
    "recipient": "GDEF...",
    "token": "CTOKEN...",
    "totalAmount": "1000000000",
    "startTime": "1700000000",
    "endTime": "1731536000",
    "cliffTime": "1705000000"
  },
  "metadata": {
    "webhookId": "wh_1a2b3c4d5e6f",
    "attemptNumber": 1,
    "contractId": "CCCCCC..."
  }
}
```

**stream.withdrawn**

```json
{
  "id": "whdlv_def456",
  "type": "stream.withdrawn",
  "createdAt": "2026-11-23T11:00:00.000Z",
  "data": {
    "streamId": "12345",
    "amount": "500000000",
    "withdrawn": "500000000",
    "recipient": "GDEF..."
  },
  "metadata": {
    "webhookId": "wh_1a2b3c4d5e6f",
    "attemptNumber": 1,
    "contractId": "CCCCCC..."
  }
}
```

**stream.cancelled**

```json
{
  "id": "whdlv_ghi789",
  "type": "stream.cancelled",
  "createdAt": "2026-11-23T12:00:00.000Z",
  "data": {
    "streamId": "12345",
    "recipientAmount": "250000000",
    "senderRefund": "250000000",
    "cancelledAt": "1735689600"
  },
  "metadata": {
    "webhookId": "wh_1a2b3c4d5e6f",
    "attemptNumber": 1,
    "contractId": "CCCCCC..."
  }
}
```

## Signature Verification

### HMAC Signing

Every webhook delivery includes an HMAC signature for authenticity verification:

**Header:** `X-TricklePay-Signature`

**Algorithm:** HMAC-SHA256

**Input:** `{timestamp}.{payload}`

**Example:**

```http
POST /webhooks/tricklepay HTTP/1.1
Host: integrator.example.com
Content-Type: application/json
X-TricklePay-Signature: t=1700000000,v1=abc123def456...
X-TricklePay-Delivery-Id: whdlv_abc123
X-TricklePay-Event-Type: stream.created

{...payload...}
```

**Signature Header Format:**

```
X-TricklePay-Signature: t={timestamp},v1={signature}
```

Where:
- `timestamp`: Unix timestamp (seconds) when signature was generated
- `signature`: HMAC-SHA256 hex digest of `{timestamp}.{JSON payload}`

### Verification Example (Receiver)

```typescript
function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const [timestampPart, signaturePart] = signature.split(',');
  const timestamp = timestampPart.split('=')[1];
  const receivedSignature = signaturePart.split('=')[1];
  
  // Reject old signatures (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) { // 5 minute tolerance
    return false;
  }
  
  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  
  // Constant-time comparison
  return crypto.timingSafeEqual(
    Buffer.from(receivedSignature),
    Buffer.from(expectedSignature)
  );
}
```

## Delivery Mechanism

### Dispatch Timing

Webhooks are dispatched **after** the event is successfully applied to the database:

```typescript
async function applyEvent(event: StreamEvent) {
  await prisma.$transaction(async (tx) => {
    // 1. Apply event to Stream table
    await updateStream(event, tx);
    
    // 2. Record IndexedEvent
    await recordIndexedEvent(event, tx);
  });
  
  // 3. Dispatch webhooks (async, non-blocking)
  void dispatchWebhooks(event).catch(err => {
    logger.error({ err, event }, 'webhook dispatch failed');
  });
}
```

**Rationale:** Webhooks are fire-and-forget from the indexer's perspective. Delivery failures do not block event application.

### HTTP Request Configuration

**Method:** POST

**Headers:**
```
Content-Type: application/json
User-Agent: TricklePay-Webhooks/1.0
X-TricklePay-Signature: t=...,v1=...
X-TricklePay-Delivery-Id: whdlv_...
X-TricklePay-Event-Type: stream.created
```

**Timeout:** 10 seconds (configurable)

**Success Criteria:**
- HTTP status 200-299
- Response received within timeout
- TCP connection successful

**Failure Triggers:**
- HTTP status 400-599
- Network timeout
- DNS resolution failure
- TCP connection refused
- TLS handshake failure

### Retry Policy

Failed deliveries are retried with exponential backoff:

| Attempt | Delay | Cumulative Time |
|---------|-------|-----------------|
| 1 (initial) | 0s | 0s |
| 2 | 30s | 30s |
| 3 | 2m | 2.5m |
| 4 | 10m | 12.5m |
| 5 | 1h | 1h 12.5m |
| 6 | 6h | 7h 12.5m |
| 7 | 24h | 31h 12.5m |

**Max attempts:** 7

**Backoff formula:** `min(30s * 2^(attempt-1), 24h)`

**Rationale:** Gradual backoff gives integrators time to fix issues without overwhelming their endpoints.

After 7 failed attempts, the delivery is marked as `permanently_failed` and no further retries are attempted. Operators can manually retry via the API.

### Retry Queue

Retries are managed by an in-process queue with persistent state:

```typescript
interface WebhookDelivery {
  id: string;                    // Delivery UUID
  webhookId: string;             // Registration ID
  eventId: string;               // Source event ID
  eventType: WebhookEvent;
  payload: object;
  status: DeliveryStatus;
  attemptCount: number;
  nextRetryAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type DeliveryStatus = 
  | 'pending'
  | 'delivering'
  | 'succeeded'
  | 'failed'
  | 'permanently_failed';
```

**Queue worker:**
- Polls `WebhookDelivery` table for pending deliveries where `nextRetryAt <= NOW()`
- Attempts delivery
- Updates status and schedules next retry on failure
- Marks as `succeeded` on success

## SSRF Protection

### Private Network Filtering

Webhook URLs must not target private or internal network addresses:

**Blocked ranges:**
- Loopback: `127.0.0.0/8`, `::1`
- Private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Link-local: `169.254.0.0/16`, `fe80::/10`
- Localhost: `localhost`, `*.local`

**Validation:**
1. Parse URL and extract hostname
2. Resolve hostname to IP address(es)
3. Check each IP against blocked ranges
4. Reject if any IP is blocked

**DNS rebinding protection:**
- Re-resolve hostname on each delivery attempt (not just registration)
- Block if resolution changes to a private IP

**Example validation:**

```typescript
async function validateWebhookUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  
  // Require HTTPS (except localhost for testing)
  if (parsed.protocol !== 'https:' && !isLocalhost(parsed.hostname)) {
    throw new Error('Webhook URL must use HTTPS');
  }
  
  // Resolve hostname to IP addresses
  const addresses = await dns.promises.resolve(parsed.hostname);
  
  // Check each IP
  for (const ip of addresses) {
    if (isPrivateIP(ip)) {
      throw new Error(`Webhook URL resolves to private IP: ${ip}`);
    }
  }
}

function isPrivateIP(ip: string): boolean {
  // Check against private ranges using ipaddr.js or similar
  const addr = ipaddr.parse(ip);
  return addr.range() === 'private' || 
         addr.range() === 'loopback' ||
         addr.range() === 'linkLocal';
}
```

**Testing exception:**
- Allow `localhost` and `127.0.0.1` when `NODE_ENV=development`
- Require `--allow-local-webhooks` flag in production

## Delivery Records

### WebhookDeliveryAttempt Table

Every delivery attempt is logged for debugging:

```prisma
model WebhookDeliveryAttempt {
  id              String   @id @default(uuid())
  deliveryId      String
  webhookId       String
  attemptNumber   Int
  requestUrl      String
  requestHeaders  Json
  requestBody     Json
  responseStatus  Int?
  responseHeaders Json?
  responseBody    String?
  error           String?
  durationMs      Int?
  createdAt       DateTime @default(now())
  
  @@index([deliveryId])
  @@index([webhookId, createdAt])
}
```

**Retention:** Delivery attempts are retained for 30 days (configurable). Older attempts are pruned by a background job.

### Delivery Logs Endpoint

**GET /webhooks/:id/deliveries**

List delivery attempts for a webhook:

```json
{
  "deliveries": [
    {
      "id": "whdlv_abc123",
      "eventType": "stream.created",
      "status": "succeeded",
      "attemptCount": 2,
      "createdAt": "2026-11-23T10:30:00.000Z",
      "lastAttemptAt": "2026-11-23T10:30:30.000Z",
      "durationMs": 234
    }
  ],
  "pagination": {...}
}
```

**GET /webhooks/:id/deliveries/:deliveryId**

Get detailed delivery information including request/response:

```json
{
  "id": "whdlv_abc123",
  "eventType": "stream.created",
  "status": "succeeded",
  "attempts": [
    {
      "attemptNumber": 1,
      "requestUrl": "https://integrator.example.com/webhooks/tricklepay",
      "responseStatus": 500,
      "error": "Internal Server Error",
      "durationMs": 234,
      "createdAt": "2026-11-23T10:30:00.000Z"
    },
    {
      "attemptNumber": 2,
      "requestUrl": "https://integrator.example.com/webhooks/tricklepay",
      "responseStatus": 200,
      "durationMs": 189,
      "createdAt": "2026-11-23T10:30:30.000Z"
    }
  ]
}
```

## Configuration

### Environment Variables

```bash
# Enable webhook delivery (default: false)
WEBHOOKS_ENABLED=true

# Worker poll interval (ms)
WEBHOOKS_POLL_INTERVAL_MS=5000

# Delivery timeout (ms)
WEBHOOKS_TIMEOUT_MS=10000

# Max concurrent deliveries
WEBHOOKS_CONCURRENCY=10

# Allow webhooks to localhost (development only)
WEBHOOKS_ALLOW_LOCAL=false
```

## Authentication & Authorization

### Webhook Management API

Webhook CRUD endpoints require authentication:

**Option 1:** API Key Authentication (Phase 1)

```http
POST /webhooks HTTP/1.1
Authorization: Bearer <API_KEY>
```

API keys are configured via environment variable and checked in middleware.

**Option 2:** Per-User Webhooks (Phase 2)

After implementing user authentication:
- Each user can register their own webhooks
- Webhooks only receive events for streams involving that user
- Filter: `sender = user.address OR recipient = user.address`

**Initial recommendation:** Start with API key auth, migrate to per-user later.

## Testing Tools

### Test Endpoint

**POST /webhooks/:id/test**

Send a test payload immediately:

```http
POST /webhooks/wh_123/test HTTP/1.1
Authorization: Bearer <API_KEY>

{
  "eventType": "stream.created"
}
```

Generates a synthetic event and delivers it immediately (no retries). Returns delivery result:

```json
{
  "deliveryId": "whdlv_test_abc",
  "status": "succeeded",
  "responseStatus": 200,
  "durationMs": 123
}
```

### Manual Retry

**POST /webhooks/:id/deliveries/:deliveryId/retry**

Manually retry a failed delivery:

```http
POST /webhooks/wh_123/deliveries/whdlv_abc/retry HTTP/1.1
Authorization: Bearer <API_KEY>
```

Resets attempt count and immediately attempts delivery.

## Metrics

```
tricklepay_webhooks_total{webhook_id,event_type} - Total webhooks fired
tricklepay_webhook_deliveries_total{webhook_id,status,event_type} - Delivery attempts by status
tricklepay_webhook_delivery_duration_ms{webhook_id,event_type} - Delivery latency histogram
tricklepay_webhook_retries_total{webhook_id,event_type} - Total retries
tricklepay_webhook_failures_total{webhook_id,failure_type} - Failures by type (timeout, 5xx, etc.)
```

## Security Considerations

### Secret Management

- Webhook secrets are generated as cryptographically random 32-byte values
- Secrets are stored in database (consider encrypting at rest)
- Secrets are never logged
- Secrets can be rotated via PATCH /webhooks/:id

### Rate Limiting

Apply rate limits per webhook registration:
- Max 1000 deliveries per hour per webhook
- Exceeding limit pauses webhook and notifies operator

### Payload Size

Limit payload size to prevent memory exhaustion:
- Max 10 KB per webhook payload
- Reject events exceeding limit

## Documentation Updates

### README.md

Add webhooks section:

```markdown
## Webhooks

Receive real-time notifications for stream events:

1. Register a webhook endpoint
2. Verify signatures on incoming payloads
3. Monitor delivery status

See [docs/webhook-design.md](docs/webhook-design.md) for complete documentation.
```

### OpenAPI Spec

Document webhook management endpoints:
- POST /webhooks
- GET /webhooks
- GET /webhooks/:id
- PATCH /webhooks/:id
- DELETE /webhooks/:id
- POST /webhooks/:id/test
- GET /webhooks/:id/deliveries

## Implementation Phases

### Phase 1: Core Delivery (MVP)

- [x] Design document (this document)
- [ ] Database schema (Webhook, WebhookDelivery, WebhookDeliveryAttempt tables)
- [ ] Registration API (POST /webhooks, GET /webhooks, DELETE /webhooks)
- [ ] HMAC signature generation
- [ ] SSRF protection (URL validation)
- [ ] Delivery worker (dispatch, retry, exponential backoff)
- [ ] Basic tests (unit + integration)

### Phase 2: Management & Observability

- [ ] Delivery history API (GET /webhooks/:id/deliveries)
- [ ] Test endpoint (POST /webhooks/:id/test)
- [ ] Manual retry (POST /webhooks/:id/deliveries/:deliveryId/retry)
- [ ] Metrics (Prometheus counters/histograms)
- [ ] Delivery attempt logging

### Phase 3: Advanced Features

- [ ] Per-user webhooks (after auth implementation)
- [ ] Event filtering (subscribe to specific senders/recipients/tokens)
- [ ] Batch deliveries (multiple events in single POST)
- [ ] Webhook templates (transform payload format)
- [ ] Dead letter queue (permanently failed events)

## Open Questions

1. **Should webhooks be scoped per contract in multi-contract deployments?**
   - **Proposal:** Yes, add `contractId` filter to webhook subscriptions.

2. **Should we support custom HTTP headers on webhook deliveries?**
   - **Proposal:** Yes, add `customHeaders` to registration (max 5 headers).

3. **Should we implement webhook verification challenges (like GitHub/Stripe)?**
   - **Proposal:** Yes, POST /webhooks sends challenge code to URL and requires echo response.

4. **How to handle webhook URL changes (PATCH)?**
   - **Proposal:** Re-validate new URL, cancel in-flight deliveries to old URL.

5. **Should delivery history be queryable by event type?**
   - **Proposal:** Yes, add `?eventType=stream.created` filter to delivery list endpoint.
