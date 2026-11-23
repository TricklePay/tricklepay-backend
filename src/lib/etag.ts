// ETag builders and the If-None-Match check shared by every route that
// supports conditional requests. Keeping them in one place means the rules in
// docs/response-headers.md hold on every route, instead of each handler
// building its own header value and comparing it its own way.

import { createHash } from "node:crypto";

/**
 * Strong ETag built from version parts, e.g. `["200", "schedule", "50"]`
 * becomes `"200-schedule-50"`. Used where the response is a pure function of
 * a stored version (the stream's `updatedLedger`) plus the request inputs.
 * Optional fieldsParam is included to differentiate responses with different field selections.
 */
export function strongEtag(...parts: Array<string | number | bigint | undefined>): string {
  const validParts = parts.filter((p) => p !== undefined);
  return `"${validParts.join("-")}"`;
}

/**
 * Weak ETag derived from the serialized body, so it changes whenever any
 * returned field changes. "Weak" (W/) is correct here: we only guarantee
 * semantic equivalence between revalidations, not byte-for-byte identity.
 */
export function weakEtagFromBody(body: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return `W/"${digest}"`;
}

// An entity-tag is an optional W/ prefix and a double-quoted opaque value
// that may not contain a double quote (RFC 9110 section 8.8.3).
const ENTITY_TAG = /^(?:W\/)?"[^"]*"$/;

// Drops the weak indicator so two tags can be compared on their opaque value.
function opaqueTag(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

/**
 * True when the request's If-None-Match header matches `etag` under RFC 9110
 * weak comparison (section 13.1.2), meaning the client already holds the
 * current representation and should get a 304.
 *
 * Accepts `*`, a comma-separated list of validators, and weak or strong forms
 * of the same value. Elements that are not valid entity-tags are ignored, so a
 * malformed header never produces a 304.
 */
export function ifNoneMatchMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw.trim() === "*") return true;

  const target = opaqueTag(etag);
  // Opaque values cannot contain a double quote, so splitting on commas
  // outside quotes is enough; a comma inside quotes is part of the value.
  const candidates = raw.match(/(?:W\/)?"[^"]*"|[^,\s][^,]*/g) ?? [];
  return candidates.some((candidate) => {
    const tag = candidate.trim();
    return ENTITY_TAG.test(tag) && opaqueTag(tag) === target;
  });
}
