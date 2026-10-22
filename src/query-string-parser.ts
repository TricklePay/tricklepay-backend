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
 *
 * Parsing alone is last-write-wins, but the server rejects a repeated parameter
 * before any handler runs (#519): a silent last-wins rule hides client mistakes
 * and is a parameter-pollution footgun. See `docs/query-parameters.md`.
 */
export function parseQueryString(str: string): Record<string, string> {
  const params = new URLSearchParams(str);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
