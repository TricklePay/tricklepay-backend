// Registers the GET /streams, GET /streams/summary, GET /tokens, GET /streams/:id/events,
// GET /streams/:id, GET /streams/:id/schedule, and GET /accounts/:address/summary endpoints.
// Each endpoint lives in its own module under routes/streams/; this plugin adds the shared
// schemas once and registers them on the same instance, in the same order as before.

import type { FastifyInstance } from "fastify";

import { DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS } from "../config.js";
import {
  ACCOUNT_STREAM_SUMMARY_SCHEMA_ID,
  ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID,
  accountStreamSummarySchema,
  accountSummaryResponseSchema,
  apiErrorSchema,
  ERROR_SCHEMA_ID,
  streamEventHistoryResponseSchema,
  streamEventSchema,
  STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID,
  STREAM_EVENT_SCHEMA_ID,
  streamListResponseSchema,
  STREAM_LIST_RESPONSE_SCHEMA_ID,
  streamScheduleResponseSchema,
  STREAM_SCHEDULE_RESPONSE_SCHEMA_ID,
  streamSummaryResponseSchema,
  STREAM_SUMMARY_RESPONSE_SCHEMA_ID,
  streamViewSchema,
  STREAM_VIEW_SCHEMA_ID,
  TOKEN_LIST_RESPONSE_SCHEMA_ID,
  rateLimitedResponseSchema,
  RATE_LIMITED_RESPONSE_SCHEMA_ID,
  serverErrorResponseSchema,
  SERVER_ERROR_RESPONSE_SCHEMA_ID,
  TOKEN_SUMMARY_SCHEMA_ID,
  tokenListResponseSchema,
  tokenSummarySchema,
} from "../schema.js";
import { registerAccountSummaryRoute } from "./streams/account-summary.js";
import { registerStreamDetailRoute } from "./streams/detail.js";
import { registerStreamEventsRoute } from "./streams/events.js";
import { registerListStreamsRoute } from "./streams/list.js";
import { registerStreamScheduleRoute } from "./streams/schedule.js";
import { registerStreamSummaryRoute } from "./streams/summary.js";
import { registerTokensRoute } from "./streams/tokens.js";

export type StreamRoutesOptions = {
  summaryCacheTtlMs?: number;
};

export async function streamRoutes(
  app: FastifyInstance,
  opts: StreamRoutesOptions = {},
): Promise<void> {
  const summaryCacheTtlMs = opts.summaryCacheTtlMs ?? DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS;

  // Ensure the shared schemas are available whether this plugin is registered
  // on a full server (which calls addSchema centrally) or a bare Fastify
  // instance in tests. Fastify deduplicates by $id, so calling addSchema when
  // the schema is already present throws; we guard against that here.
  if (!app.getSchema(STREAM_VIEW_SCHEMA_ID)) app.addSchema(streamViewSchema);
  if (!app.getSchema(STREAM_LIST_RESPONSE_SCHEMA_ID)) app.addSchema(streamListResponseSchema);
  if (!app.getSchema(STREAM_SUMMARY_RESPONSE_SCHEMA_ID)) {
    app.addSchema(streamSummaryResponseSchema);
  }
  if (!app.getSchema(STREAM_EVENT_SCHEMA_ID)) app.addSchema(streamEventSchema);
  if (!app.getSchema(STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID)) {
    app.addSchema(streamEventHistoryResponseSchema);
  }
  if (!app.getSchema(TOKEN_SUMMARY_SCHEMA_ID)) {
    app.addSchema(tokenSummarySchema);
  }
  if (!app.getSchema(TOKEN_LIST_RESPONSE_SCHEMA_ID)) {
    app.addSchema(tokenListResponseSchema);
  }
  if (!app.getSchema(ACCOUNT_STREAM_SUMMARY_SCHEMA_ID)) {
    app.addSchema(accountStreamSummarySchema);
  }
  if (!app.getSchema(ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID)) {
    app.addSchema(accountSummaryResponseSchema);
  }
  if (!app.getSchema(STREAM_SCHEDULE_RESPONSE_SCHEMA_ID)) {
    app.addSchema(streamScheduleResponseSchema);
  }
  if (!app.getSchema(ERROR_SCHEMA_ID)) app.addSchema(apiErrorSchema);
  if (!app.getSchema(RATE_LIMITED_RESPONSE_SCHEMA_ID)) app.addSchema(rateLimitedResponseSchema);
  if (!app.getSchema(SERVER_ERROR_RESPONSE_SCHEMA_ID)) app.addSchema(serverErrorResponseSchema);

  registerListStreamsRoute(app);
  registerStreamSummaryRoute(app, summaryCacheTtlMs);
  registerTokensRoute(app);
  registerStreamEventsRoute(app);
  registerStreamDetailRoute(app);
  registerStreamScheduleRoute(app);
  registerAccountSummaryRoute(app);
}
