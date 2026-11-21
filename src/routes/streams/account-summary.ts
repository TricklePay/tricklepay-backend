// GET /accounts/:address/summary: incoming and outgoing totals for one address.

import type { FastifyInstance } from "fastify";

import { summarizeAccountStreams } from "../../lib/account-summary.js";
import { normalizeAddress } from "../../lib/address.js";
import { sendError } from "../../lib/response.js";
import { nowSeconds } from "../../lib/time.js";
import { getAccountStreams } from "../../repositories/streams.js";
import { ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID, ERROR_SCHEMA_ID } from "../../schema.js";

export function registerAccountSummaryRoute(app: FastifyInstance): void {
  app.get(
    "/accounts/:address/summary",
    {
      schema: {
        summary: "Get account stream summary",
        description:
          "Returns incoming and outgoing stream counts and exact amount totals for a single Stellar address. " +
          "Derived amounts (vested, withdrawable) are calculated against the current time using the same rules as the stream view.",
        tags: ["streams"],
        params: {
          type: "object",
          required: ["address"],
          properties: {
            address: {
              type: "string",
              description: "Stellar account public key or contract address.",
              examples: ["GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
            },
          },
        },
        response: {
          200: { $ref: ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID },
          400: { $ref: ERROR_SCHEMA_ID },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params as { address: string };
      const normalized = normalizeAddress(address);
      if (!normalized) {
        return sendError(reply, request, 400, "VALIDATION_ERROR", "invalid address");
      }

      const { incoming, outgoing } = await getAccountStreams(normalized);
      const now = nowSeconds();

      reply.header("Cache-Control", "public, max-age=30");
      return {
        incoming: summarizeAccountStreams(incoming, now),
        outgoing: summarizeAccountStreams(outgoing, now),
      };
    },
  );
}
