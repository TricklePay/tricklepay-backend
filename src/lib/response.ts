// Shared helpers for building consistent API error responses and serializing
// large integers. Centralizing these prevents error shapes from drifting
// between routes as new endpoints are added.

import type { FastifyReply, FastifyRequest } from "fastify";

import type { ApiErrorCode } from "../error-redaction.js";

// ---------------------------------------------------------------------------
// Error response helper (#160, #744)
//
// Every API error carries a structured response that supports both the
// legacy envelope (code, error, requestId) and RFC 9457 problem details
// (type, title, status, detail plus extension members). The client's Accept
// header determines which format is returned.
// ---------------------------------------------------------------------------

const ACCEPT_PROBLEM_JSON = "application/problem+json";
const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/**
 * Determines whether the client accepts RFC 9457 problem details.
 */
function acceptsProblemDetails(request: FastifyRequest): boolean {
  const acceptHeader = request.headers.accept;
  if (!acceptHeader) return false;
  return String(acceptHeader).toLowerCase().includes(ACCEPT_PROBLEM_JSON);
}

/**
 * Converts an error code to a human-readable title, e.g. `NOT_FOUND`
 * becomes "Not Found".
 */
function titleForCode(code: ApiErrorCode): string {
  return code
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Builds an RFC 9457 problem details object. The legacy fields stay as
 * top-level extension members so existing clients keep reading the same
 * names, and any route-specific extras are spread at the top level too.
 */
function buildProblemDetails(
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extraExtensions: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: `https://api.tricklepay.example/errors/${code.toLowerCase()}`,
    title: STATUS_TITLES[statusCode] ?? titleForCode(code),
    status: statusCode,
    detail: message,
    code,
    error: message,
    requestId,
    ...extraExtensions,
  };
}

/**
 * Sends a structured JSON error response and returns the reply so handlers
 * can `return sendError(...)` to satisfy TypeScript's return-type checker.
 *
 * @param reply - The Fastify reply object for the current request.
 * @param request - The Fastify request object, used to echo the request id.
 * @param statusCode - HTTP status code (400, 404, 500, …).
 * @param code - Stable machine-readable error code (`VALIDATION_ERROR`, `NOT_FOUND`, …).
 * @param message - Human-readable error description sent to the caller.
 * @param extraExtensions - Optional top-level extension members for problem details.
 */
export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  extraExtensions: Record<string, unknown> = {},
): ReturnType<FastifyReply["send"]> {
  if (reply.sent) return reply as unknown as ReturnType<FastifyReply["send"]>;

  const problemDetails = acceptsProblemDetails(request);
  const response = problemDetails
    ? buildProblemDetails(statusCode, code, message, request.id, extraExtensions)
    : {
        code,
        error: message,
        requestId: request.id,
        ...extraExtensions,
      };

  return reply
    .code(statusCode)
    .header(
      "content-type",
      problemDetails ? ACCEPT_PROBLEM_JSON : "application/json",
    )
    .send(response);
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
