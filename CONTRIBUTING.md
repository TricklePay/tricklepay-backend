# Contributing to TricklePay Backend

Thank you for contributing to `tricklepay-backend`! This guide covers local environment setup, mandatory quality checks, coding conventions, repository layer standards, and instructions for submitting a pull request.

For overarching architecture, security models, and cross-repository contribution standards, please refer to the shared [TricklePay Documentation Guide](https://github.com/TricklePay/tricklepay-docs).

---

## Local Setup

### Requirements

- **Node.js**: `^20.12.0` (see `.nvmrc` and `engines.node` in `package.json`).
- **Docker & Docker Compose**: For local PostgreSQL database or full stack containerization.
- **Soroban Contract ID**: A deployed stream contract address (`STREAM_CONTRACT_ID`).

### Development Steps

1. **Clone the repository and set up Node:**

   ```bash
   git clone https://github.com/TricklePay/tricklepay-backend.git
   cd tricklepay-backend
   nvm use
   ```

2. **Configure Environment Variables:**

   ```bash
   cp .env.example .env
   ```

   Open `.env` and set `STREAM_CONTRACT_ID` to your target Soroban contract address.

3. **Install Dependencies and Generate Prisma Client:**

   ```bash
   npm install
   ```

4. **Start Development Stack:**

   ```bash
   ./scripts/dev.sh
   ```

   Alternatively, run the full stack via Docker Compose:

   ```bash
   docker compose up --build
   ```

---

## Code Quality Checks

TricklePay Backend enforces comprehensive code quality verification across type checking, unit tests, production compilation, dependency integrity, integration testing, test coverage, and container builds.

### Required Checks Summary

The table below outlines each check, its command, prerequisites, and CI status:

| Check | Command | Prerequisites | CI Status |
| --- | --- | --- | --- |
| TypeScript type check | `npm run typecheck` | Dependencies installed (`npm ci`) | Executed in `CI` (`build` matrix: Node 20, 22) |
| Unit tests | `npm test` | Dependencies installed (`npm ci`) | Executed in `CI` (`build` matrix: Node 20, 22) |
| Production build | `npm run build` | Dependencies installed (`npm ci`) | Executed in `CI` (`build` matrix: Node 20, 22) |
| Dependency check | `npm run depcheck` | Dependencies installed (`npm ci`) | Executed in `CI` (`depcheck` job: Node 22) |
| Integration tests | `npm run test:integration` | Running PostgreSQL instance with migrations and shadow DB | Executed in `CI` (`migration-check` matrix: Postgres 16, 17) |
| Test coverage | `npm run test:coverage` | Dependencies installed (`npm ci`) | Executed in `CI` (`coverage` job: Node 22) |
| Container image build | `docker build --tag tricklepay-backend:ci .` | Running Docker daemon | Executed in `CI` (`docker-build`) and `Container image` |
| Dependency security audit | `npm audit` | Dependencies installed (`npm ci`) | Executed in `Dependency Audit` workflow |

### Local Verification Script

For quick local verification before opening a pull request, run the checks script:

```bash
./scripts/check.sh
```

This runs `npm run typecheck`, `npm test`, and `npm run build` in order, failing immediately on the first error.

### Detailed Check Specifications

#### 1. TypeScript Type Checking (`npm run typecheck`)
- **What it does**: Runs `tsc --noEmit` on the application source tree (`src/`) and `tsc -p tsconfig.test.json` on the test suite (`tests/`).
- **Prerequisites**: `npm ci` (or `npm install`) to ensure `node_modules` and the generated Prisma client (`node_modules/@prisma/client`) exist.
- **CI**: Executed on every pull request and push to `main` across Node.js 20 and Node.js 22.

#### 2. Unit Tests (`npm test`)
- **What it does**: Runs the Vitest unit test suite (`vitest run --project unit`). Mocks database calls and chain RPC endpoints to isolate business logic, vesting schedules, and route handlers.
- **Prerequisites**: Installed dependencies.
- **CI**: Executed on every pull request and push to `main` across Node.js 20 and Node.js 22.

#### 3. Production Build (`npm run build`)
- **What it does**: Compiles all TypeScript files in `src/` to JavaScript files in `dist/` using the production `tsconfig.json`.
- **Prerequisites**: Installed dependencies.
- **CI**: Executed on every pull request and push to `main` across Node.js 20 and Node.js 22.

#### 4. Dependency Audit and Unused Package Check (`npm run depcheck`)
- **What it does**: Scans the codebase with `depcheck` to guarantee there are no undeclared dependencies in `package.json` and no obsolete or unused packages (configured in `.depcheckrc.yml`).
- **Prerequisites**: Installed dependencies.
- **CI**: Executed on every pull request and push to `main` in the `depcheck` job.

#### 5. Integration Tests (`npm run test:integration`)
- **What it does**: Executes end-to-end repository and database integration tests (`vitest run --project integration`) against real PostgreSQL schemas.
- **Prerequisites**: A running PostgreSQL database and empty shadow database. You can launch the dedicated test database container via:
  ```bash
  docker compose --profile test up -d postgres-test
  DATABASE_URL=postgresql://tricklepay_test:tricklepay_test@localhost:5433/tricklepay_test npx prisma migrate deploy
  docker compose exec postgres-test createdb -U tricklepay_test tricklepay_shadow
  DATABASE_URL=postgresql://tricklepay_test:tricklepay_test@localhost:5433/tricklepay_test SHADOW_DATABASE_URL=postgresql://tricklepay_test:tricklepay_test@localhost:5433/tricklepay_shadow npm run test:integration
  ```
- **CI**: Executed in the `migration-check` workflow matrix across both PostgreSQL 16 and PostgreSQL 17.

#### 6. Test Coverage (`npm run test:coverage`)
- **What it does**: Runs the unit test suite with the V8 coverage provider, generating human-readable tables, HTML reports, and `coverage/coverage-summary.json`.
- **Prerequisites**: Installed dependencies.
- **CI**: Executed in the `coverage` job.

#### 7. Container Build and Health Check
- **What it does**: Verifies that the multi-stage Dockerfile compiles properly, builds both the migration image and the lean runtime image, and passes the HTTP `/health` probe.
- **Prerequisites**: Local Docker daemon.
- **CI**: Executed in `CI` (`docker-build`) and `Container image` (`smoke-test` and `scan`).

### Code Quality Standards

- **Type Safety**: Maintain strict TypeScript adherence without disabling lint rules or using implicit `any`.
- **Unit Testing**: Add comprehensive unit tests under `tests/` covering domain logic, error conditions, and edge cases.
- **Error Handling**: Use structured `ApiErrorCode` and sanitize sensitive error information.

### Dependency Audit Policy

The `Dependency Audit` workflow (`.github/workflows/audit.yml`) runs `npm audit` in two modes:

- **Pull requests** fail only on **high or critical advisories that the pull request introduces**. The workflow audits the pull request's `package-lock.json` and the base branch's in the same run, and fails if the pull request has a high or critical advisory the base does not. Advisories already present on `main` are listed in the job summary but do not fail the check. If your pull request adds or upgrades a dependency and the check fails, upgrade or replace that dependency rather than ignoring the result.
- **The daily scheduled run** (also runnable by hand from the Actions tab) reports the full list of advisories against `main` in its job summary and fails on any high or critical one, so the existing backlog stays visible. Fixing that backlog belongs in a dedicated pull request.

### Workflow Permissions

Every workflow declares `permissions: contents: read` at the top level. A job that needs more (for example, writing a commit status) must request exactly that in its own `permissions` block.

---

## Code Conventions

### Import Ordering

Keep import statements structured cleanly in the following canonical order:

1. **Node built-ins** (`node:*`, e.g., `node:path`, `node:fs`).
2. **Third-party packages** (alphabetized, e.g., `fastify`, `prisma`).
3. **Relative imports** (alphabetized by path, e.g., `./config`, `../repositories/streams`).

Separate each group with a single blank line.

---

## Repository Layer Conventions

All database access in this service is strictly confined to the repository layer under `src/repositories/`.

### Architecture Rule: Database Isolation

- **Prisma calls must ONLY exist inside `src/repositories/`**:
  Route handlers (`src/routes/`), indexer modules (`src/indexer/`), chain listeners (`src/chain/`), and domain utilities (`src/lib/`) must **never** import `prisma` from `src/db.js` or run raw database queries directly.
- All database reads, writes, aggregations, and transaction boundaries must be encapsulated in exported repository functions.

### Writing a Repository Function

When adding or modifying repository functions (e.g. in `src/repositories/streams.ts`, `src/repositories/indexer-state.ts`, or `src/repositories/failed-events.ts`), adhere to the following standards:

1. **Input Typing**: Define an explicit TypeScript `interface` or `type` for all arguments (e.g., `StreamFilter`, `UpsertStreamInput`). Avoid passing untyped `any` or loose parameter bags.
2. **Transaction Support**: Write mutating repository functions to optionally accept a Prisma transaction client:
   ```typescript
   export async function insertStream(
     input: InsertStreamInput,
     tx: Prisma.TransactionClient = prisma
   ): Promise<ApplyResult> {
     // ...
   }
   ```
3. **Domain Representation & BigInt Handling**:
   - Database numbers storing 64-bit or 128-bit values are mapped to `Prisma.Decimal` or `bigint`.
   - Conversions should be handled cleanly within the repository function or view mappers.
4. **Idempotency & Replay Safety**:
   - Write operations should handle duplicate events safely (e.g. using `skipDuplicates`, conditional update guards like `notYetApplied`, or `upsert`).

### Example: `getStream` and `listStreams`

See [`src/repositories/streams.ts`](src/repositories/streams.ts) for reference implementations:

```typescript
// Single-record lookup
export async function getStream(streamId: bigint): Promise<Stream | null> {
  return prisma.stream.findUnique({ where: { streamId } });
}

// Filtered and paginated list
export async function listStreams(filter: StreamFilter): Promise<Stream[]> {
  return prisma.stream.findMany({
    where: whereFromFilter(filter),
    orderBy: orderByFromFilter(filter),
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
  });
}
```

---

## Adding a New Route

Every route in this codebase follows the same four-step pattern. Work through them in order to keep the codebase consistent and the published OpenAPI specification up to date.

### 1. Create the route file

Add a new file under `src/routes/`. The file should export an async plugin function that accepts a `FastifyInstance` and registers one or more path handlers on it. See [`src/routes/status.ts`](src/routes/status.ts) for a minimal example: it imports its repository helpers at the top, then calls `app.get(...)` with a handler.

### 2. Register the plugin in `server.ts`

Import the plugin function and call `app.register(yourRoutes)` inside `buildServer` in [`src/server.ts`](src/server.ts). The order matters: register the plugin _after_ the shared schemas are added (the `app.addSchema(...)` block) but before the server is returned.

### 3. Attach a JSON Schema - required for the published specification

Every route that returns a response body **must** attach a JSON Schema to its route definition via the `schema.response` option. This is not optional: `@fastify/swagger` generates the published OpenAPI specification by inspecting those schemas at startup, so a route without one is invisible to consumers of the spec.

**How to do it:**

1. Define the schema object in [`src/schema.ts`](src/schema.ts) with a unique `$id`. Use the existing definitions in that file as a guide.
2. Call `app.addSchema(yourSchema)` in the route plugin (guard the call with `if (!app.getSchema(YOUR_SCHEMA_ID))` so the plugin can be registered on both the full server and a bare Fastify instance in tests without throwing).
3. Reference the schema in the route definition:
   ```ts
   app.get("/your-path", {
     schema: {
       summary: "Short description",
       tags: ["your-tag"],
       response: { 200: { $ref: YOUR_SCHEMA_ID } },
     },
   }, handler);
   ```

### 4. Decide whether the route touches the database

Routes that read from the database import their data through a repository function in `src/repositories/`. Routes that do not need the database (like `/health`) can be registered directly in `server.ts` without a separate repository file. Choose the approach that matches the responsibility of the route and document the decision in a short comment at the top of the file.

**Example reference:** [`src/routes/status.ts`](src/routes/status.ts) is a good starting point - it is short, touches the database through two repository functions, registers a response schema, and includes a server-side cache with an injectable TTL for testability.

---

## Submitting Pull Requests

1. **Create a Feature Branch:**

   ```bash
   git checkout -b feat/short-description
   # or for documentation updates:
   git checkout -b docs/short-description
   ```

2. **Commit Your Changes:**
   Write concise, descriptive commit messages matching conventional commit format:
   `feat(<scope>): description (#issue)` or `docs(<scope>): description (#issue)`.

3. **Open a Pull Request:**
   - Push your branch to `origin`.
   - Open a PR against the `main` branch.
   - Include `Closes #<ISSUE_NUMBER>` in the PR description to link and automatically close relevant issues.

---

## Shared Guidelines

For broader guidelines on contract interaction, network configurations, and security practices across all TricklePay repositories, visit the [TricklePay Shared Docs](https://github.com/TricklePay/tricklepay-docs).

---

## Code of Conduct

Please note that this project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project, you agree to abide by its terms.
