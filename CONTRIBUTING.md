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

Before submitting a pull request, run the local checks script to ensure type safety, test validity, and build success:

```bash
./scripts/check.sh
```

This script will run type checking, unit tests, and the build step in order, exiting non-zero on the first failure.

### Code Quality Standards

- **Type Safety**: Maintain strict TypeScript adherence without disabling lint rules or using implicit `any`.
- **Unit Testing**: Add comprehensive unit tests under `tests/` covering domain logic, error conditions, and edge cases.
- **Error Handling**: Use structured `ApiErrorCode` and sanitize sensitive error information.

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

### 3. Attach a JSON Schema — required for the published specification

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

**Example reference:** [`src/routes/status.ts`](src/routes/status.ts) is a good starting point — it is short, touches the database through two repository functions, registers a response schema, and includes a server-side cache with an injectable TTL for testability.

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
