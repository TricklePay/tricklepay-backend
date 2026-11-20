# End-to-End Request Lifecycle

This document describes the end-to-end journey of an HTTP request through the TricklePay backend service, detailing the responsibility of each layer from socket connection to response serialization.

---

## Architectural Flowchart

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Incoming HTTP Request                           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Request ID Hook (`onRequest` in `src/server.ts`)                    │
│    - Extracts/sanitizes `x-request-id` header or generates fresh UUID  │
│    - Binds `reqId` to request logger; sets `x-request-id` header       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. CORS & Proxy Layer (`@fastify/cors` & `src/proxy.ts`)               │
│    - Validates Origin against `CORS_ORIGIN` allowlist                  │
│    - Determines trusted client IP via `trustProxy` configuration       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. URL Parsing & Schema Validation (Fastify Router & `src/schema.ts`)  │
│    - Maps URL pattern and checks `queryStringLimit`                    │
│    - Validates query/param types against JSON schemas                  │
│    - Short-circuits with 400 VALIDATION_ERROR on schema violations     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Route Handler (`src/routes/streams.ts`, `src/routes/status.ts`)     │
│    - Parses domain filters, bounds limits, normalizes Stellar addresses│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. Repository Layer (`src/repositories/streams.ts`, `indexer-state.ts`)│
│    - Queries PostgreSQL database via Prisma client                     │
│    - Applies pagination, filtering, ordering, and aggregation          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 6. Domain & Vesting Computation Layer (`src/lib/vesting.ts`)           │
│    - Transforms raw database records into API views (`toView`)         │
│    - Computes live `vested`, `withdrawable`, `locked`, `progress`      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 7. Serialization & Response Headers (Fastify & Route Handlers)         │
│    - Serializes JSON payload; attaches `Cache-Control` & `ETag` headers│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 8. Post-Response Metrics & Logging (`onResponse` in `src/server.ts`)   │
│    - Increments `httpRequestsTotal` & observes `httpRequestDuration`   │
│    - Emits structured completion log line with `res.statusCode`        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Outgoing HTTP Response                          │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Breakdown by Layer

### Layer 1: Request Identification (`src/server.ts`)
- **Hook**: `onRequest` and Fastify `genReqId`.
- **Action**: Inspects the incoming `x-request-id` header. If present and compliant with character and length constraints (`/^[A-Za-z0-9._-]{1,64}$/`), it is reused; otherwise, a random UUID v4 is generated.
- **Output**: Request ID is set in the outgoing response header and attached to all logger instances as `reqId`.

### Layer 2: CORS & Proxy Evaluation (`src/server.ts`, `src/proxy.ts`)
- **Action**: Evaluates client Origin header against `CORS_ORIGIN`. Evaluates peer IP against `trustedProxies` to securely resolve `X-Forwarded-For` without IP spoofing vulnerabilities.

### Layer 3: Query Parsing and Schema Validation (`src/server.ts`, `src/schema.ts`)
- **Action**: Custom `querystringParser` checks length against `QUERY_STRING_LIMIT`. Fastify validates query parameters (`limit`, `offset`, `includeTotal`, `cancelled`) and path parameters (`id`) against JSON schemas.
- **Failure**: If validation fails, Fastify rejects the request immediately before executing business logic.

### Layer 4: Route Handlers (`src/routes/`)
- **Action**: Coordinates domain parameter parsing (e.g. normalizing base32 Stellar addresses with `StrKey.isValidEd25519PublicKey`).

### Layer 5: Repository Layer (`src/repositories/`)
- **Action**: Encapsulates all database communication via Prisma (`src/db.ts`). Executes indexed queries over the PostgreSQL `Stream` and `IndexerState` tables.

### Layer 6: Domain Logic & Vesting View (`src/lib/vesting.ts`)
- **Action**: Evaluates linear vesting formulas at the exact wall-clock second of the request, computing derived fields (`vested`, `withdrawable`, `locked`, `progress`, `status`).

### Layer 7: Response Serialization & Cache Headers (`src/routes/`)
- **Action**: Sets caching headers (`Cache-Control: public, max-age=30`). `GET /streams/:id` sets `ETag: "<updatedLedger>"`; `GET /streams` sets a weak `ETag` derived from the response body. Both evaluate `If-None-Match` and return `304 Not Modified` with no body when it matches.

### Layer 8: Metrics, Logging & Error Handling (`src/server.ts`)
- **Hook**: `onResponse` and `app.setErrorHandler()`.
- **Action**: Updates Prometheus metrics (`httpRequestsTotal`, `httpRequestDuration`) and logs completion details. Any unhandled error is caught, sanitized via `redactErrorMessage`, and returned with the appropriate `ApiErrorCode`.
