# Endpoint Failure Modes and Error Handling

This document provides a comprehensive reference of all failure modes, HTTP status codes, and machine-readable error codes returned by the TricklePay Backend API.

## Error Response Structure

All error responses (4xx and 5xx) adhere to a consistent JSON format defined in [`src/schema.ts`](../src/schema.ts):

```json
{
  "code": "VALIDATION_ERROR",
  "error": "offset must not exceed 10000. Page through results in order with limit and offset...",
  "requestId": "f79ff125-8c18-47bf-bae1-6940eaa1efb6"
}
```

### Machine-Readable Error Codes (`ApiErrorCode`)

- **`VALIDATION_ERROR`**: Client sent malformed parameters, invalid types, or values violating bounds (HTTP 400).
- **`NOT_FOUND`**: Requested resource or route does not exist (HTTP 404).
- **`REQUEST_ERROR`**: Client request could not be processed (Other HTTP 4xx).
- **`INTERNAL_SERVER_ERROR`**: Unexpected server or database exception (HTTP 500). Internal messages are redacted to prevent credential or SQL leaks.

---

## Endpoint Failure Matrix

### 1. `GET /ready` (Readiness Probe)
- **Failure Condition**: PostgreSQL database connection is down or unreachable.
- **HTTP Status**: `503 Service Unavailable`
- **Retry-After**: The response includes a `Retry-After` header with the number of seconds to wait before probing again. The value defaults to `5` and is configurable with `READINESS_RETRY_AFTER_SECONDS`; a ready (`200`) response does not include it.
- **Response Format**:
  ```json
  {
    "status": "not_ready",
    "database": "down",
    "error": "database connection timeout"
  }
  ```

---

### 2. `GET /streams` (List Streams)
- **Failure Condition 1**: `offset` parameter exceeds `10000`.
  - **HTTP Status**: `400 Bad Request`
  - **Code**: `VALIDATION_ERROR`
  - **Message**: `"offset must not exceed 10000. Page through results in order with limit and offset, or narrow them with the sender, recipient, and token filters."`
- **Failure Condition 2**: Invalid Stellar address in `sender`, `recipient`, or `token` filter.
  - **HTTP Status**: `400 Bad Request`
  - **Code**: `VALIDATION_ERROR`
  - **Message**: `"invalid <sender|recipient|token> address"`
- **Failure Condition 3**: Query string length exceeds configured `QUERY_STRING_LIMIT`.
  - **HTTP Status**: `400 Bad Request`
  - **Code**: `VALIDATION_ERROR`
  - **Message**: `"query string too long"`
- **Failure Condition 4**: Unhandled database error during fetch/count.
  - **HTTP Status**: `500 Internal Server Error`
  - **Code**: `INTERNAL_SERVER_ERROR`
  - **Message**: `"internal server error"`

---

### 3. `GET /streams/:id` (Get Stream by ID)
- **Failure Condition 1**: Non-numeric or invalid integer `id` parameter.
  - **HTTP Status**: `400 Bad Request`
  - **Code**: `VALIDATION_ERROR`
  - **Message**: `"invalid stream id"`
- **Failure Condition 2**: Stream ID does not exist in the database.
  - **HTTP Status**: `404 Not Found`
  - **Code**: `NOT_FOUND`
  - **Message**: `"stream not found"`
- **Failure Condition 3**: Database query failure.
  - **HTTP Status**: `500 Internal Server Error`
  - **Code**: `INTERNAL_SERVER_ERROR`
  - **Message**: `"internal server error"`

---

### 4. `GET /streams/summary` (Stream Metrics Summary)
- **Failure Condition**: Database query failure during aggregation.
  - **HTTP Status**: `500 Internal Server Error`
  - **Code**: `INTERNAL_SERVER_ERROR`
  - **Message**: `"internal server error"`

---

### 5. `GET /status` (Indexer Status)
- **Note**: Always returns 200 OK. If the indexer has not yet run its first poll, `indexer.initialized` returns `false` and `lagLedgers` returns `null`.

---

### 6. Unmatched Routes (Catch-All)
- **Failure Condition**: Request method or URL does not match any registered route.
  - **HTTP Status**: `404 Not Found`
  - **Code**: `NOT_FOUND`
  - **Message**: `"Route <METHOD> <PATH> not found"`
