// ---------------------------------------------------------------------------
// Shared JSON schema registration (#240).
//
// All $id-bearing schema objects must be registered with Fastify before any
// route references them with $ref. @fastify/swagger picks them up from the
// store and emits them as named OpenAPI components.
//
// Every `*_SCHEMA_ID` exported from `./schema.ts` must have its schema listed
// here exactly once; `tests/schema-registration.test.ts` enforces that (#713).
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";

import {
  accountStreamSummarySchema,
  accountSummaryResponseSchema,
  apiErrorSchema,
  apiIndexSchema,
  indexerStatusSchema,
  streamEventHistoryResponseSchema,
  streamEventSchema,
  streamListResponseSchema,
  streamScheduleResponseSchema,
  streamSummaryResponseSchema,
  streamViewSchema,
  tokenListResponseSchema,
  tokenSummarySchema,
} from "./schema.js";

/** Every shared schema, in registration order. */
export const SHARED_SCHEMAS = [
  streamViewSchema,
  streamListResponseSchema,
  streamSummaryResponseSchema,
  streamScheduleResponseSchema,
  streamEventSchema,
  streamEventHistoryResponseSchema,
  tokenSummarySchema,
  tokenListResponseSchema,
  accountStreamSummarySchema,
  accountSummaryResponseSchema,
  indexerStatusSchema,
  apiErrorSchema,
  apiIndexSchema,
] as const;

/**
 * Every shared schema, in registration order. Schemas referenced by others
 * with $ref (e.g. StreamView from StreamListResponse) come first.
 */
export const SHARED_SCHEMAS = [
  streamViewSchema,
  streamListResponseSchema,
  streamSummaryResponseSchema,
  streamScheduleResponseSchema,
  streamEventSchema,
  streamEventHistoryResponseSchema,
  tokenSummarySchema,
  tokenListResponseSchema,
  accountStreamSummarySchema,
  accountSummaryResponseSchema,
  indexerStatusSchema,
  apiErrorSchema,
  apiIndexSchema,
] as const;

/**
 * Adds every shared JSON Schema definition to the Fastify schema store so
 * routes can reference them with `{ $ref: "$id" }`.
 */
export function registerSharedSchemas(app: FastifyInstance): void {
  for (const schema of SHARED_SCHEMAS) {
    app.addSchema(schema);
  }
}
