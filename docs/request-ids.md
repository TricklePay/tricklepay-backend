# Request IDs

Every API request processed by the TricklePay backend is assigned a unique Request ID. This ID is essential for tracing requests across logs, especially when debugging issues or matching client reports to server-side telemetry.

## Client-Supplied IDs

Clients can optionally supply their own Request ID by sending the `x-request-id` HTTP header. 
The server will honor and use this client-supplied ID if it passes the following validation logic:

1. **Type & Length:** It must be a string and no longer than 64 characters.
2. **Format:** It must match the regular expression `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. This means the ID must start with an alphanumeric character and otherwise contain only letters, digits, dots, underscores, and hyphens (e.g., `client-trace-42`, `abcdef01-2345`).

If the supplied `x-request-id` fails any of these checks, or if the header is omitted entirely, the server will override/reject the value and generate a fresh random UUID for the request.

## Where Request IDs Appear

The assigned Request ID (whether client-supplied or server-generated) appears in three places:

- **Response Headers:** It is echoed back to the client in the `x-request-id` HTTP response header on every response, even if the request fails early.
- **Error Responses:** It is included in the `requestId` field of structured API error response bodies.
- **Server Logs:** It is bound to the per-request child logger and lands in every structured request log line as the `reqId` field.
