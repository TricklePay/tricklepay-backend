// ---------------------------------------------------------------------------
// Query string parser (#242).
//
// Fastify's default query string parser is `fast-querystring`. This custom
// parser uses the built-in `URLSearchParams` API so the parsing rules are
// consistent with the web platform. Moving it here makes the limit behaviour
// testable without constructing a full server.
// ---------------------------------------------------------------------------

/**
 * Parses a raw query string (without the leading `?`) into a plain record.
 * Duplicate keys are last-write-wins, matching the behaviour of the inline
 * parser that was previously defined inside `buildServer`.
 */
export function parseQueryString(str: string): Record<string, string> {
  const params = new URLSearchParams(str);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
