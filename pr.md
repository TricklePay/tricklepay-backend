# Fix issues #8, #9, #10, and #11

All four issues have been resolved in this PR.

## Summary

- **#8 Configure CORS** — Registered `@fastify/cors` with an env-driven origin allowlist (`CORS_ORIGIN`). Frontend can now call the API from its dev origin.
- **#9 Replace prisma db push with migrations** — Committed initial migration under `prisma/migrations/`. Both `docker-compose.yml` and `scripts/dev.sh` now run `prisma migrate deploy` instead of `db push`.
- **#10 Raise declared Node version to 20.12** — `engines.node` in `package.json` is now `>=20.12`. README updated to state the same minimum.
- **#11 Add a readiness endpoint** — New `/ready` endpoint verifies database connectivity and reports indexer lag. Returns 503 when a dependency is unavailable.
