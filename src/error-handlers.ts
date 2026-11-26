// ---------------------------------------------------------------------------
// Error handlers (#240).
//
// The global error handler and the not-found handler are registered here.
// Both attach the request id to the response body so a client-reported error
// can be matched to its log lines. Error messages are redacted before they
// leave the server (#74).
// ---------------------------------------------------------------------------

import type { FastifyError, FastifyInstance } from "fastify";

import { QueryTimeoutError } from "./db.js";
import { errorCodeForStatus, redactErrorMessage } from "./error-redaction.js";
import { sendError } from "./lib/response.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

/**
 * Registers the global error handler and the not-found handler on `app`.
 * Both handlers attach `requestId`, a stable `code`, and a redacted `error`
 * message to every failure response.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  // Attach the request id to error bodies so an error a client saw can be
  // traced to its log lines. Status codes are preserved and each failure
  // carries a stable machine-readable code (#73). Outgoing messages are
  // redacted so connection strings, SQL fragments, or stack traces never
  // reach the client (#74); the original error is logged server-side with
  // the request id for diagnosis.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (reply.sent) {
      return;
    }

    const isDatabaseError =
      err instanceof QueryTimeoutError ||
      (typeof err.message === "string" &&
        /Can't reach database server|P1001|ECONNREFUSED.*5432|connect ECONNREFUSED/i.test(
          err.message,
        ));

    if (isDatabaseError) {
      request.log.error({ err }, "database unavailable");
      void reply.header("Retry-After", "30");
      sendError(reply, request, 503, "SERVICE_UNAVAILABLE", "internal server error");
      return;
    }

    const statusCode =
      typeof err.statusCode === "number" && err.statusCode >= 400
        ? err.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err }, "request failed");
    }
    const message =
      statusCode >= 500
        ? "internal server error"
        : redactErrorMessage(err.message);
    sendError(reply, request, statusCode, errorCodeForStatus(statusCode), message);
  });

  // Unmatched routes bypass the error handler, so they get their own handler
  // with the request id attached like every other error response.
  app.setNotFoundHandler((request, reply) => {
    sendError(
      reply,
      request,
      404,
      errorCodeForStatus(404),
      `Route ${request.method} ${request.url} not found`,
    );
  });
}
