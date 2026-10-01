// ---------------------------------------------------------------------------
// Request-id hook (#240).
//
// Echoes the per-request id on every response so clients can quote it back.
// Registered before routing so even requests that fail early carry the header.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";

import { REQUEST_ID_HEADER } from "./request-id.js";

/**
 * Registers the onRequest hook that sets the `x-request-id` response header
 * on every reply.
 */
export function registerRequestIdHook(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
}
