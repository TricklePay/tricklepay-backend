# Response Headers by Endpoint

Every response carries `x-request-id` (see [request-ids.md](request-ids.md)) and
the security headers described under [Security headers](#security-headers).
Most `GET` responses also carry `X-Indexer-Lag-Ledgers` (see
[`X-Indexer-Lag-Ledgers`](#x-indexer-lag-ledgers)), and large responses are
compressed (see [Compression](#compression-content-encoding-and-vary)).
Beyond that, which headers a response carries — and what a client may rely on
— varies by route. This table states it explicitly so it doesn't have to be
read back out of `src/routes/*.ts`, `src/health-routes.ts`,
`src/request-id-hook.ts`, `src/indexer-lag-hook.ts`, and `src/server.ts`.

| Endpoint | `Cache-Control` | `ETag` | Other headers | Set only on success? |
| --- | --- | --- | --- | --- |
| `GET /` | — | — | — | — |
| `GET /health` | — | — | — | — |
| `GET /ready` | — | — | — | — |
| `GET /status` | `no-store` | — | — | Yes (always 200; see below) |
| `GET /streams` | `public, max-age=30` | `W/"<sha256 of the body>"` | — | Yes — a 400 carries neither |
| `GET /streams/summary` | `public, max-age=N` (variable, see below) | — | — | Always 200 |
| `GET /streams/:id` (also `HEAD`) | `public, max-age=30` | `"<updatedLedger>"`, or `"<updatedLedger>-<at>"` with `?at=` | — | Yes — 400/404 carry neither |
| `GET /streams/:id/events` | `public, max-age=30` | — | — | Yes — 400/404 carry neither |
| `GET /streams/:id/schedule` | `public, max-age=30` | `"<updatedLedger>-schedule-<points>"` | — | Yes — 400/404 carry neither |
| `GET /accounts/:address/summary` | `public, max-age=30` | — | — | Yes — 400 carries neither |
| `GET /tokens` | `public, max-age=30` | — | — | Always 200 |
| `GET /metrics` | — | — | `Content-Type: text/plain; version=0.0.4; charset=utf-8` | — |
| Any route, `429` (rate limited) | — | — | `Retry-After: <seconds>` | — |
| Any unmatched route, `404` | — | — | — | — |

`x-request-id` is omitted from the table because it's on every row: it's set
in an `onRequest` hook that runs before routing (`src/request-id-hook.ts`),
so it's present even on a 404 for a path that matches no route, a 429 from
the rate limiter, and a 400 from schema validation.
`X-Indexer-Lag-Ledgers`, `Content-Encoding`, and `Vary` are also omitted:
they are added by hooks to responses on most rows, under the conditions
described in their own sections below, rather than by the route.

`/docs`, `/docs/json`, and `/docs/yaml` aren't listed — their caching headers
are `@fastify/swagger-ui`'s defaults. They do carry the security headers below,
because those are registered globally before the docs plugin.

## Security headers

Every response — API, docs, error, and 404 — carries the same hardening headers,
registered by [`src/security-headers.ts`](../src/security-headers.ts):

| Header | Value | Why |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | An error body is JSON; a browser must never sniff it as HTML. |
| `Content-Security-Policy` | `default-src 'self'; …; frame-ancestors 'none'` | Restricts what the docs page and any rendered response may load. `script-src 'self'` and inline styles are allowed so the Swagger UI assets keep working; `upgrade-insecure-requests` is deliberately omitted so the docs work over plain HTTP in local development. |
| `Referrer-Policy` | `no-referrer` | Query strings can carry addresses; never leak them to third parties. |
| `Cross-Origin-Resource-Policy` | `cross-origin` | Matches the API's deliberate CORS policy for non-CORS consumers. |

HSTS is left at helmet's default: it is emitted on the response but only
honoured by browsers when the request is actually served over HTTPS.

## Why `Cache-Control` is set the way it is

- **`public, max-age=30` on `/streams`, `/streams/:id`, `/streams/:id/events`,
  `/streams/:id/schedule`, `/accounts/:address/summary`, and `/tokens`.**
  These all read current database state and can be requested repeatedly in a
  short window (a client polling a stream's page, a dashboard refreshing a
  list). Thirty seconds is short enough that a client never acts on data more
  than half a poll interval stale under the default configuration, but long
  enough to absorb bursts of identical requests without hitting Postgres for
  each one.
- **`no-store` on `/status`.** The service's own lag figure must never be
  served from a cache, at any layer — see the "Cache behaviour" note in
  [the README](../README.md#stream-summary-endpoint) (it covers `/status`
  immediately after the summary endpoint's own caching rules).
  The route has its own 2-second in-process cache (`STATUS_CACHE_TTL_MS`) for
  load, but that is a server-side detail; the HTTP header tells every
  downstream cache and browser to never store the response at all, so a
  proxy sitting in front of this service can't make a stale lag figure look
  current.
- **`public, max-age=N` with a variable `N` on `/streams/summary`.** This
  route also holds an in-process cache (`STREAM_SUMMARY_CACHE_TTL_MS`,
  default 2 seconds), and `N` is the seconds *remaining* in that window, not
  a fixed number — see
  [the Stream Summary Endpoint section of the README](../README.md#stream-summary-endpoint).
  A fixed `max-age` would let an HTTP cache keep serving the response after
  the server itself has already recomputed it; counting down to the same
  deadline the server's own cache uses means a client's cached copy expires
  at the same moment the server's does, never later.
- **No `Cache-Control` at all on `/`, `/health`, `/ready`, and `/metrics`.**
  Each of these is meant to be read fresh on every call rather than tuned for
  a caching window: `/health` and `/ready` are liveness/readiness probes
  typically polled directly by an orchestrator, not through a shared cache;
  `/metrics` must reflect current counter values for whatever scrape
  interval Prometheus is configured with, not this service's opinion of one;
  and `/` is a low-traffic service index with nothing worth tuning.
- **Never set on an error response.** On every route above, the
  `Cache-Control` (and `ETag`, where applicable) header is set after
  validation and existence checks, in the same statement that builds the
  success body. A 400 or 404 from `sendError` (`src/lib/response.ts`) returns
  before that line runs, so an error response never carries a caching
  directive left over from the success path.

## `ETag` and conditional requests

Three routes set `ETag`, and each replies `304` with an empty body when the
incoming `If-None-Match` equals it, rather than re-sending a response the
client already has. The `Cache-Control` header is set before the comparison,
so a `304` carries it too.

- **`GET /streams/:id` and `GET /streams/:id/schedule`** set a strong `ETag`
  derived from the stream's `updatedLedger` — the ledger of the last event
  actually applied to that stream — plus any request-specific input that
  changes the response (`?at=` for the stream view, the point count for the
  schedule). Nothing is recomputed to produce it beyond the row lookup.
- **`GET /streams`** sets a weak `ETag`, `W/"<hex sha256>"`, computed over the
  JSON response body (`streams`, `total` when requested, `nextCursor`,
  `limit`, and `offset`). A list has no single version column to derive a tag
  from, so the body is built and hashed on every request; what the `304`
  saves is the transfer, not the database query. Any change to any returned
  field changes the tag, and so do the derived figures (`vested`,
  `withdrawable`, `progress`, …), which move with the clock — a list with an
  active stream in it therefore revalidates only within the same second. It
  is weak because the guarantee is semantic equivalence, and it is computed
  before compression, so it is the same whichever `Content-Encoding` the
  response is sent with.

No other endpoint sets `ETag`: `/streams/:id/events`, `/streams/summary`,
`/tokens`, and `/accounts/:address/summary` don't send one, so a client
revalidates them only by refetching after `max-age` expires.

## `X-Indexer-Lag-Ledgers`

[`src/indexer-lag-hook.ts`](../src/indexer-lag-hook.ts) adds
`X-Indexer-Lag-Ledgers: <n>` in an `onSend` hook, so a client can see how
fresh the data is without a separate `/status` call. `<n>` is
`max(0, chainLedger - lastLedger)` — the same figure `GET /status` reports
as `lagLedgers` (see [indexer-lag.md](indexer-lag.md)).

- **Which responses carry it.** Every `GET` response, whatever its status
  (including `304`, `400`, and `404`), except paths starting with `/health`
  or `/ready` and the exact path `/metrics`. `HEAD`
  requests (including `HEAD /streams/:id`) never carry it, because the hook
  only acts on `GET`.
- **When it is omitted.** Before the indexer's first poll, when there is no
  recorded position yet, and when the position cannot be read (for example
  during a database outage); the response is otherwise unaffected.
- **Caching.** The value is read from `IndexerState` and cached in-process
  for 2 seconds, so it can trail `/status` by that much. It describes the lag
  at the moment the response was produced: a copy served from an HTTP cache
  under `Cache-Control: public, max-age=30` carries the value from when it
  was stored, up to 30 seconds old. Use `GET /status` (`no-store`) when the
  current figure matters.
- **Browsers.** It is not in the CORS exposed headers, so browser JavaScript
  on another origin cannot read it — see
  [CORS origin](../README.md#cors-origin).

## Compression: `Content-Encoding` and `Vary`

`@fastify/compress` is registered globally in
[`src/server.ts`](../src/server.ts). A response is compressed when all of
these hold:

- the request's `Accept-Encoding` names an encoding the plugin supports
  (`br`, `gzip`, or `deflate`; the client's preference order is respected),
  and the request does not carry `x-no-compression`;
- the body is at least `COMPRESSION_THRESHOLD_BYTES` (default `1024`; see
  the [configuration table](../README.md#configuration));
- the content type is compressible (JSON and text, so every API response),
  and the status is not `206`.

A compressed response carries `Content-Encoding: <encoding>`, `Vary:
accept-encoding` (appended to any existing `Vary`), and a `Content-Length`
for the compressed bytes. Responses below the threshold, or for clients that
don't ask for compression, are sent as-is with neither `Content-Encoding` nor
the `Vary` entry, so small responses such as `/health` and single-stream
lookups are usually uncompressed. Compression happens after the route has set
`ETag` and `Cache-Control`, so neither depends on the encoding.
