// GET /tokens: each distinct token with its stream count and total amount.

import type { FastifyInstance } from "fastify";

import { listTokens } from "../../repositories/streams.js";
import {
  RATE_LIMITED_RESPONSE_SCHEMA_ID,
  SERVER_ERROR_RESPONSE_SCHEMA_ID,
  TOKEN_LIST_RESPONSE_SCHEMA_ID,
} from "../../schema.js";

export function registerTokensRoute(app: FastifyInstance): void {
  app.get(
    "/tokens",
    {
      schema: {
        summary: "List distinct tokens",
        description:
          "Returns each distinct token with its stream count and total streamed amount across all streams, including completed and cancelled ones. " +
          "Totals are aggregated in the database over decimal columns, so they never lose precision.",
        tags: ["streams"],
        response: {
          200: { $ref: TOKEN_LIST_RESPONSE_SCHEMA_ID },
          429: { $ref: RATE_LIMITED_RESPONSE_SCHEMA_ID },
          500: { $ref: SERVER_ERROR_RESPONSE_SCHEMA_ID },
        },
      },
    },
    async (_request, reply) => {
      const tokens = await listTokens();
      reply.header("Cache-Control", "public, max-age=30");
      return tokens;
    },
  );
}
