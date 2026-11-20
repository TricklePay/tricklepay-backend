// ---------------------------------------------------------------------------
// Request-id hook (#240).
//
// Echoes the per-request id on every response so clients can quote it back.
// The header is set in `onSend`, which runs for every reply — route handlers,
// the error and not-found handlers, and replies sent early by other hooks
// (rate limiting, query-string hardening, timeouts) — so it does not depend
// on the order in which hooks are registered (#712).
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";

import { REQUEST_ID_HEADER } from "./request-id.js";

/**
 * Registers the onSend hook that sets the `x-request-id` response header
 * on every reply.
 */
export function registerRequestIdHook(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    return payload;
  });
}
