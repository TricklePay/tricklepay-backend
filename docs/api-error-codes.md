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
- `error`: A human-readable error message. Note that for `INTERNAL_SERVER_ERROR`, original raw error details (such as stack traces or SQL fragments) are redacted for security, and a generic "internal server error" message is returned instead.
- `requestId`: The request ID associated with the error (useful for correlating client errors with server-side logs).

## Defined Error Codes

The backend defines and returns the following error codes based on the HTTP status code of the failure:

- `VALIDATION_ERROR`
  - **Returned When:** The request is invalid or malformed (HTTP status `400`). This could be due to missing required fields, invalid parameters, or malformed request bodies.
- `NOT_FOUND`
  - **Returned When:** The requested resource or route cannot be found (HTTP status `404`).
- `REQUEST_ERROR`
  - **Returned When:** The request fails with any other 4xx client error (e.g., HTTP statuses `401`, `403`, `409`, etc.) that is not explicitly a `VALIDATION_ERROR` or `NOT_FOUND`.
- `INTERNAL_SERVER_ERROR`
  - **Returned When:** An unexpected server-side error occurs (HTTP status `500` and above). The original error message is logged internally with the request ID, but the client receives a safe, redacted message.
