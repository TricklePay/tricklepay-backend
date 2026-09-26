// Shared helpers for building consistent API error responses and serializing
// large integers. Centralizing these prevents error shapes from drifting
// between routes as new endpoints are added.

import type { FastifyReply, FastifyRequest } from "fastify";

import type { ApiErrorCode } from "../server.js";

// ---------------------------------------------------------------------------
// Error response helper (#160)
//
// Every API error carries the same three-field envelope: a stable
// machine-readable code, a human-readable message, and the request id so the
// client can quote it back when reporting a problem.
// ---------------------------------------------------------------------------

/**
 * Sends a structured JSON error response and returns the reply so handlers
 * can `return sendError(...)` to satisfy TypeScript's return-type checker.
 *
 * @param reply - The Fastify reply object for the current request.
 * @param request - The Fastify request object, used to echo the request id.
 * @param statusCode - HTTP status code (400, 404, 500, …).
 * @param code - Stable machine-readable error code (`VALIDATION_ERROR`, `NOT_FOUND`, …).
 * @param message - Human-readable error description sent to the caller.
 */
export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
): ReturnType<FastifyReply["send"]> {
  return reply.code(statusCode).send({
    code,
    error: message,
    requestId: request.id,
  });
}

// ---------------------------------------------------------------------------
// BigInt serialization helper (#159)
//
// Token amounts are stored as Prisma Decimal or computed as bigint and must
// be rendered as decimal strings in JSON responses. A missed `.toString()`
// call would silently emit a number and lose precision for values above
// 2^53 − 1. These helpers make every conversion site uniform and explicit.
// ---------------------------------------------------------------------------

/**
 * Converts a bigint or Prisma Decimal-like value to a decimal string.
 *
 * Use this wherever a token amount crosses the API boundary so that no
 * large integer is accidentally serialized as a lossy IEEE 754 number.
 *
 * @param value - A bigint or any object whose `.toString()` yields its decimal representation.
 * @returns The value as a decimal string.
 */
export function bigIntToString(value: bigint | { toString(): string }): string {
  return value.toString();
}

/**
 * Converts a nullable bigint or Prisma Decimal-like value to a decimal
 * string, or `null` when the value is absent.
 *
 * @param value - A bigint / Decimal-like value, `null`, or `undefined`.
 * @returns The decimal string, or `null`.
 */
export function bigIntToStringNullable(
  value: bigint | { toString(): string } | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}
