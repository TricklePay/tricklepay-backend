# API Versioning and Stability Policy

This document defines the versioning policy, stability guarantees, and change management procedures for the TricklePay Backend HTTP API.

## Current API Version

**The TricklePay API is now served under the `/v1` prefix for all stable endpoints.**

- **Versioned Endpoints (Stable)**: All production endpoints are available under `/v1/*`:
  - `/v1/` — API index
  - `/v1/health` — Liveness check
  - `/v1/ready` — Readiness check
  - `/v1/status` — Indexer progress
  - `/v1/streams` — List streams
  - `/v1/streams/summary` — Stream summary by status
  - `/v1/streams/:id` — Single stream detail
  - `/v1/streams/:id/events` — Stream event history
  - `/v1/streams/:id/schedule` — Vesting schedule
  - `/v1/accounts/:address/summary` — Account stream summary
  - `/v1/tokens` — List distinct tokens
  - `/v1/metrics` — Prometheus metrics

- **Unversioned Endpoints (Deprecated)**: The original unversioned paths (`/streams`, `/status`, etc.) remain functional but are **deprecated**. They are marked as deprecated in the OpenAPI specification and will be removed in a future major version. Clients should migrate to `/v1/*` endpoints.

- **Documentation**: The OpenAPI specification is served at `/docs`, `/docs/json`, and `/docs/yaml`. The specification includes both versioned and unversioned routes, with the unversioned routes clearly marked as deprecated.

---

## Stability Expectation

The TricklePay API is a contract between the backend service, the web client (`tricklepay-frontend`), indexers, and third-party integrations.

- **Current API Status**: All `/v1/*` endpoints represent the **stable v1 API**. The unversioned endpoints are maintained for backwards compatibility during the transition period.
- **Specification**: The authoritative API specification is served live via OpenAPI 3.0 at `/docs`, `/docs/json`, and `/docs/yaml`.

---

## What Counts as a Breaking Change

A change is considered **breaking** if it requires client authors to modify their integration code to avoid failure or incorrect behavior.

### Breaking Changes (Require Major Version Increment)
- **Field Removal or Renaming**: Deleting or renaming existing fields in JSON response schemas (e.g. renaming `streamId` or `totalAmount`).
- **Data Type or Unit Modification**: Changing the data type of an existing field (e.g. changing string-encoded integers to JSON numbers, altering time units from seconds to milliseconds).
- **Route or Method Alteration**: Removing, renaming, or changing the HTTP verb of an endpoint (e.g. changing `GET /streams/:id` to `GET /stream/:id`).
- **Stricter Validation Rules**: Adding new required query parameters, headers, or request body fields.
- **Error Code & Status Code Semantics**: Modifying the structured `ApiErrorCode` enum values (`VALIDATION_ERROR`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`, `REQUEST_ERROR`) or changing standard HTTP status codes.

### Non-Breaking Changes (Released in Minor or Patch Updates)
- **Adding Optional Query Parameters**: Introducing new optional filters or pagination controls.
- **Adding Optional Response Fields**: New optional fields may be added to JSON responses without a major version increment. These additions are non-breaking; clients should ignore unknown response fields.
- **Adding New Endpoints**: Introducing new routes that do not alter existing paths.
- **Performance & Bug Fixes**: Internal optimizations that maintain existing schema and contract semantics.

---

## Communication and Deprecation Process

When a breaking change is deemed necessary:

1. **Advance Deprecation Notice**:
   - Deprecations will be documented in [CHANGELOG.md](../CHANGELOG.md) and flagged in the OpenAPI schema (`deprecated: true`).
   - Deprecated features will remain functional for at least one minor release cycle before removal.
   - The unversioned API paths are currently deprecated and will be removed in v2.0.0. Clients should migrate to `/v1/*` endpoints.

2. **Major Version Bumping & Path Prefixing**:
   - Breaking API revisions will bump the major version in `package.json` following [SemVer](https://semver.org/).
   - Major API redesigns will introduce versioned path prefixes (e.g., `/v2/streams`) to allow parallel operation while clients migrate.
   - The current stable API is served under `/v1/*`. Future breaking changes will introduce `/v2/*` while `/v1/*` continues to function.

3. **Changelog Documentation**:
   - Every release includes a detailed list of additions, changes, fixes, and migration guides in `CHANGELOG.md`.

---

## Migration Guide: Unversioned → /v1

To migrate from the deprecated unversioned endpoints to the stable `/v1` API:

1. **Update all API calls** to include the `/v1` prefix:
   - `GET /streams` → `GET /v1/streams`
   - `GET /streams/:id` → `GET /v1/streams/:id`
   - `GET /status` → `GET /v1/status`
   - etc.

2. **Test your integration** against the `/v1` endpoints to ensure compatibility.

3. **No schema changes**: The response schemas, query parameters, and headers are identical between unversioned and `/v1` endpoints during the transition period.

4. **Timeline**: Unversioned endpoints will be removed in the next major version (v2.0.0). Plan your migration accordingly.
