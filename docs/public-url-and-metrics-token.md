# Public base URL and metrics token

Two optional variables matter as soon as the service runs behind a reverse
proxy or is scraped by Prometheus:

- `PUBLIC_BASE_URL` — the server URL written into the OpenAPI document.
- `METRICS_TOKEN` — a bearer token required on `GET /metrics`.

Both appear in the [README configuration table](../README.md#configuration);
this page shows how to set them in practice, what they default to, and what
happens when they are wrong.

## `PUBLIC_BASE_URL`

### What it does

The OpenAPI document served at `/docs/json` and `/docs/yaml` has a single
`servers` entry. Its `url` is `PUBLIC_BASE_URL`
([`src/config.ts`](../src/config.ts), passed to `buildSwaggerConfig` in
[`src/api-spec.ts`](../src/api-spec.ts)). Generated clients use it as their
default base URL, and the Swagger UI at `/docs` sends its "Try it out"
requests there.

The value is fixed at startup. It is **not** derived from the incoming
request, so `X-Forwarded-Host` / `X-Forwarded-Proto` and `TRUSTED_PROXIES`
have no effect on it.

### Default

When the variable is unset or blank, the URL is built from `HOST` and `PORT`
by `defaultPublicBaseUrl`:

| `HOST` | `PORT` | Advertised URL |
| --- | --- | --- |
| `0.0.0.0` (default) | `3000` (default) | `http://localhost:3000` |
| `::` | `3000` | `http://localhost:3000` |
| `127.0.0.1` | `8080` | `http://127.0.0.1:8080` |
| `::1` | `3000` | `http://[::1]:3000` |

Wildcard bind addresses are replaced with `localhost` because a client cannot
dial `0.0.0.0`. The default is always `http://`, so it is only right for local
development.

### Behind a reverse proxy

Suppose the service listens on `0.0.0.0:3000` inside a private network and a
proxy serves it publicly as `https://api.tricklepay.example`:

```nginx
server {
    listen 443 ssl;
    server_name api.tricklepay.example;

    location / {
        proxy_pass http://tricklepay-backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Without `PUBLIC_BASE_URL`, `/docs/json` advertises the internal address:

```bash
$ curl -s https://api.tricklepay.example/docs/json | jq '.servers'
[
  {
    "url": "http://localhost:3000",
    "description": "This deployment"
  }
]
```

A client generated from that document calls `http://localhost:3000` by
default, and the Swagger UI's "Try it out" requests go to the reader's own
machine. Set the public URL instead:

```env
PUBLIC_BASE_URL=https://api.tricklepay.example
# Trust the proxy so client IPs are logged and rate-limited correctly
# (separate from PUBLIC_BASE_URL; see the README's "Trusted proxies").
TRUSTED_PROXIES=10.0.0.5
```

After a restart:

```bash
$ curl -s https://api.tricklepay.example/docs/json | jq '.servers'
[
  {
    "url": "https://api.tricklepay.example",
    "description": "This deployment"
  }
]
```

Guidelines for the value:

- Use the URL clients actually reach — scheme, host and, if it is not the
  default for the scheme, port.
- If the proxy mounts the API under a path prefix (for example
  `https://example.com/tricklepay`), include the prefix; clients append
  route paths such as `/streams` to it.
- Leave off the trailing slash. Clients join the base URL and the route path,
  and `https://api.tricklepay.example/` would give them `//streams`.
- Keep it on the same origin that serves `/docs`. The
  [Content-Security-Policy](../README.md#security-headers) sets
  `connect-src 'self'`, so if `PUBLIC_BASE_URL` points at another origin the
  browser blocks the Swagger UI's "Try it out" requests. The document itself
  is still correct for generated clients.

### Failure behaviour

`PUBLIC_BASE_URL` is not validated. A non-blank value is used as given — it is
not parsed as a URL, normalised, or checked against the request — and a blank
value falls back to the default. A wrong value therefore never stops the
service from starting; it shows up only as a wrong `servers[0].url` in
`/docs/json`. Check it after every deployment change:

```bash
curl -s "$PUBLIC_BASE_URL/docs/json" | jq -r '.servers[0].url'
```

The value is also part of the effective configuration printed at startup and
by `npm run print-config`.

## `METRICS_TOKEN`

### What it does

When `METRICS_TOKEN` is set, `GET /metrics`
([`src/routes/metrics.ts`](../src/routes/metrics.ts)) requires:

```http
Authorization: Bearer <token>
```

The token is compared in constant time. The `Bearer` scheme name is matched
case-insensitively; the token itself is case-sensitive. No other endpoint is
affected.

### Default

Unset, blank, or whitespace-only (the value is trimmed) means no token:
`/metrics` is unauthenticated, as it was before the variable existed. Keep
the endpoint off the public network either way — the token is an extra layer,
not a replacement for network restriction — and only send it over TLS.

### Prometheus scrape example

Generate a token and give it to the service:

```bash
openssl rand -hex 32
```

```env
METRICS_TOKEN=3f1c...e9a2
```

Store the same token in a file readable by Prometheus (for example a mounted
Kubernetes secret) and point the scrape job at it:

```yaml
scrape_configs:
  - job_name: tricklepay-backend
    metrics_path: /metrics
    scheme: http          # use https when scraping through a TLS proxy
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/tricklepay-metrics-token
    static_configs:
      - targets: ["tricklepay-backend:3000"]
```

`authorization.credentials_file` is preferred over putting the token in the
config. Older Prometheus versions use the equivalent, now deprecated,
`bearer_token_file` (or `bearer_token`) field:

```yaml
    bearer_token_file: /etc/prometheus/secrets/tricklepay-metrics-token
```

Check the token by hand:

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics | head
```

### Failure behaviour

A missing header, a header that is not `Bearer <token>`, and a wrong token all
get the same response, so a caller cannot use it to probe the secret:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="metrics"
Content-Type: application/json; charset=utf-8

{"code":"REQUEST_ERROR","error":"unauthorized","requestId":"..."}
```

In Prometheus the target shows as **down** on the Targets page with the error
`server returned HTTP status 401 Unauthorized`, and `up{job="tricklepay-backend"}`
is `0`. The usual causes are a token file whose value differs from
`METRICS_TOKEN`, a scrape job without the `authorization` block, or the
service restarted with a new token that the secret was not updated to match.

The service starts normally with any value; there is no startup error for
`METRICS_TOKEN`.
