# Database Requirements & Versioning

TricklePay uses PostgreSQL through Prisma for its indexed stream state and related event data. This document distinguishes versions exercised by the repository from versions for which compatibility has not been verified.

## Tested PostgreSQL versions

| Environment | PostgreSQL version | Source |
| --- | --- | --- |
| GitHub Actions integration tests | **16** | `.github/workflows/ci.yml` (`services.postgres.image: postgres:16`) |
| Local development database | **17** | `docker-compose.yml` (`postgres:17-alpine`) |
| Local integration-test database | **17** | `docker-compose.yml` (`postgres-test`, `postgres:17-alpine`) |

**Verified baseline:** PostgreSQL 16 is the oldest version exercised by the current repository CI configuration. PostgreSQL 17 is used by the supplied Docker Compose development and test services. The previous statement that PostgreSQL **15.0** was the minimum supported version and matched `postgres:15-alpine` was incorrect: neither the current CI workflow nor Docker Compose uses PostgreSQL 15.

Do not interpret this tested-version list as a guarantee that every later PostgreSQL major version has been exercised. If deploying on a different version, verify migrations and integration tests against that version before using it in production.

## Database features

TricklePay relies on PostgreSQL features used by its Prisma schema, migrations and stream-indexing queries, including UUID generation, JSON/JSONB data, and conflict-handling during updates. These features do **not**, by themselves, establish a PostgreSQL 15 minimum:

- `gen_random_uuid()` is available in PostgreSQL 13 and later.
- JSONB support predates PostgreSQL 15.
- `INSERT ... ON CONFLICT DO UPDATE` predates PostgreSQL 15.

Use the tested versions above when choosing a database for development or CI. When changing the database baseline, update the Compose images, CI service image and this document together.
