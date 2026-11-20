# API Versioning and Stability Policy

This document defines the versioning policy, stability guarantees, and change management procedures for the TricklePay Backend HTTP API.

## Stability Expectation

The TricklePay API is a contract between the backend service, the web client (`tricklepay-frontend`), indexers, and third-party integrations.

- **Current API Status**: The following endpoints represent **v1 (stable)**: `/`, `/health`, `/ready`, `/status`, `/streams`, `/streams/summary`, `/streams/:id`, `/streams/:id/events`, `/streams/:id/schedule`, `/metrics`, and `/docs`.
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

2. **Major Version Bumping & Path Prefixing**:
   - Breaking API revisions will bump the major version in `package.json` following [SemVer](https://semver.org/).
   - Major API redesigns will introduce versioned path prefixes (e.g., `/v2/streams`) to allow parallel operation while clients migrate.

3. **Changelog Documentation**:
   - Every release includes a detailed list of additions, changes, fixes, and migration guides in `CHANGELOG.md`.
