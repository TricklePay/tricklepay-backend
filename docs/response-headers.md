# Response Headers by Endpoint

Every response carries `x-request-id` (see [request-ids.md](request-ids.md)) and
the security headers described under [Security headers](#security-headers).
Beyond that, which headers a response carries — and what a client may rely on
— varies by route. This table states it explicitly so it doesn't have to be
read back out of `src/routes/*.ts`, `src/health-routes.ts`, and
`src/request-id-hook.ts`.

| Endpoint | `Cache-Control` | `ETag` | Other headers | Set only on success? |
| --- | --- | --- | --- | --- |
| `GET /` | — | — | — | — |
| `GET /health` | — | — | — | — |
| `GET /ready` | — | — | — | — |
| `GET /status` | `no-store` | — | — | Yes (always 200; see below) |
| `GET /streams` | `public, max-age=30` | — | — | Yes — a 400 carries neither |
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

Only `GET /streams/:id` and `GET /streams/:id/schedule` set `ETag`. Both
derive it from the stream's `updatedLedger` — the ledger of the last event
actually applied to that stream — plus any request-specific input that
changes the response (`?at=` for the stream view, the point count for the
schedule). Both check the incoming `If-None-Match` against that same value
and reply `304` with an empty body on a match, rather than recomputing and
re-sending a response the client already has.

No other endpoint sets `ETag`: `/streams`, `/streams/:id/events`, `/tokens`,
and `/accounts/:address/summary` all return collections or aggregates that
don't reduce to one stream's `updatedLedger`, so there is no single version
token to compare against.
