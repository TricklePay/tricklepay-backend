// ---------------------------------------------------------------------------
// Shared JSON schema registration (#240).
//
// All $id-bearing schema objects must be registered with Fastify before any
// route references them with $ref. @fastify/swagger picks them up from the
// store and emits them as named OpenAPI components.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";

import {
  apiErrorSchema,
  apiIndexSchema,
  indexerStatusSchema,
  streamListResponseSchema,
  streamSummaryResponseSchema,
  streamViewSchema,
} from "./schema.js";

/**
 * Adds every shared JSON Schema definition to the Fastify schema store so
 * routes can reference them with `{ $ref: "$id" }`.
 */
export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema(streamViewSchema);
  app.addSchema(streamListResponseSchema);
  app.addSchema(streamSummaryResponseSchema);
  app.addSchema(indexerStatusSchema);
  app.addSchema(apiErrorSchema);
  app.addSchema(apiIndexSchema);
}
