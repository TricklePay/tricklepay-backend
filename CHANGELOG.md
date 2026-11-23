# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `totalAmount` is the canonical amount total in account summaries, `/streams/summary`, and `/tokens`. The `total` amount field in account summaries and `/tokens` is deprecated; it remains through at least one minor release and is planned for removal in v2. Clients should switch to `totalAmount`.

### Added
- Initial entry capturing the current public API and operational baseline.
- `GET /tokens` endpoint: returns each distinct token contract address with its stream count and total amount (#481).
- `GET /accounts/:address/summary` endpoint: returns incoming and outgoing stream counts and total amounts for a Stellar address (#522).
- `GET /streams/:id/schedule` endpoint: returns computed vesting schedule points for a stream (#547).
- `ids` query parameter on `GET /streams`: filters by a comma-separated list of stream ids (1-100 entries) (#489).
- `status` query parameter on `GET /streams`: filters by lifecycle status (`pending`, `streaming`, `completed`, `cancelled`) (#512).
- `minAmount` and `maxAmount` query parameters on `GET /streams`: filters streams by total amount range (#518).
- `X-Indexer-Lag-Ledgers` response header on read endpoints: reports the indexer's lag in ledgers so clients can assess data freshness without polling `/status` (#531).
- `ENABLE_DOCS_UI` environment variable: controls whether the interactive Swagger UI is served at `/docs`. Default `true`; set to `false` to serve only the spec at `/docs/json` and `/docs/yaml` (#572).
- `RATE_LIMIT_ALLOWLIST` environment variable: comma-separated list of IP addresses or CIDR blocks exempt from rate limiting (#584).
- `COMPRESSION_THRESHOLD_BYTES` environment variable: minimum response size for gzip/brotli compression. Default 1024 bytes (#601).
- `CONNECTION_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS` environment variables: fine-grained HTTP connection and request timeout controls (#613).
- `INDEXER_LAG_WARN_LEDGERS` environment variable: ledger count above which the indexer logs a lag warning. Default 1000 (roughly 90 minutes); 0 disables (#627).
- `READY_MAX_STALENESS_MS` environment variable: maximum allowed staleness for `/ready` to report healthy. Default 0 (disabled) (#638).
- `READINESS_RETRY_AFTER_SECONDS` environment variable: `Retry-After` header value (in seconds) on 503 responses from `/ready`. Default 5 (#638).
- `STREAM_SUMMARY_CACHE_TTL_MS` environment variable: cache duration for `GET /streams/summary` responses. Default 2000ms (#648).
- `METRICS_TOKEN` environment variable: optional bearer token for `/metrics` endpoint authentication. When unset, `/metrics` remains unauthenticated (#662).
- `ADMIN_TOKEN` environment variable: optional bearer token for admin endpoints. When set, enables `POST /admin/replay` for triggering failed event replay via API. When unset, admin endpoints are disabled (#736).
- `tricklepay_repository_query_duration_ms` Prometheus metric: histogram of repository function execution durations in milliseconds, labeled by function name. Provides observability into which database operations are slow (#735).
- Response compression: gzip and brotli encoding for responses at or above `COMPRESSION_THRESHOLD_BYTES` (#601).
- Security headers: `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` on all responses including `/docs` (#520).
- CI builds the container image and waits for its `HEALTHCHECK` to report healthy against a PostgreSQL service (#702).
- CI scans the container image with Trivy, failing on critical findings outside `.trivyignore`, and uploads the report (#703).
- Version tags (`v*`) publish the image to `ghcr.io/tricklepay/tricklepay-backend` with OCI labels and record its digest in the release notes (#704).
- CycloneDX SBOMs for the npm dependencies and the container image are attached to CI runs and releases (#705).

### Changed
- CORS handling: `CORS_ORIGIN` now accepts a comma-separated list of allowed origins. Previously only a single origin was supported (#545).
- Rate limit exemptions: addresses in `RATE_LIMIT_ALLOWLIST` bypass the rate limiter entirely, not just receive higher limits (#584).
- Error responses: 5xx errors now return a generic `"internal server error"` message instead of exposing internal error details. The full error remains in the server log with the `requestId` for correlation (#74, #215).
