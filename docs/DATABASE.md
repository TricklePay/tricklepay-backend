# Database Requirements & Versioning

To ensure full compatibility with TricklePay backend migrations, Prisma ORM queries, and indexing performance, operators must deploy against a supported PostgreSQL version.

---

## 1. Minimum Supported Database Version

* **Minimum Supported Version**: **PostgreSQL 16**. Older releases are not exercised by CI and are not supported.
* **Tested versions**: PostgreSQL 16 (CI, via `.github/workflows/ci.yml`) and PostgreSQL 17 (local development and the integration suite, via `docker-compose.yml`).
* **Compose image**: Both the `postgres` and `postgres-test` services in `docker-compose.yml` use `postgres:17-alpine`.

To confirm the version of a deployed database, run `SELECT version();`.

---

## 2. Features the schema depends on

The schema and the queries built on top of it use only features that every supported version provides:

1. **Upserts (`ON CONFLICT ... DO UPDATE`)**:
   * Stream state is written with an upsert so that two indexer ticks applying the same event cannot create duplicate rows (`src/repositories/streams.ts`). Available since PostgreSQL 9.5.
2. **Composite B-tree indexes**:
   * `Stream`, `IndexedEvent` and `FailedEvent` carry composite indexes (for example `[sender, streamId(sort: Desc)]`) so that list and audit queries stay on an index scan instead of scanning the table. Available in every supported version.
3. **`bigint` and `DECIMAL(40,0)` columns**:
   * On-chain amounts are 128-bit integers, so they are stored as wide fixed-point decimals, and identifiers and ledger heights are stored as 64-bit integers. No value is truncated.

The schema declares no `uuid` and no `jsonb` columns, so no extension (for example `pgcrypto`) and no JSONB-specific operator is required.

PostgreSQL 16 is the floor because it is the lowest version the project tests, not because one of the features above requires it.
