# Database Migration Workflow

This guide explains how to create and apply database schema migrations using Prisma. The TricklePay backend uses migration files rather than schema pushes to track and version database changes.

## Overview

The project uses [Prisma](https://www.prisma.io/) as the database toolkit and ORM. Schema changes are made by:

1. Editing `prisma/schema.prisma`
2. Creating a migration file with `prisma migrate dev`
3. Applying the migration to the database

Migrations are version-controlled SQL files stored in `prisma/migrations/`. Each migration is applied in order, and Prisma tracks which migrations have been run using a `_prisma_migrations` table.

## When to Create a Migration

Create a migration whenever you change the database schema in `prisma/schema.prisma`:

- Adding a new model (table)
- Adding, removing, or modifying fields
- Changing field types or constraints
- Adding or removing indexes
- Altering relationships between models

## Creating a Migration

### Step 1: Edit the Schema

Make your changes in `prisma/schema.prisma`. For example, adding a new field:

```prisma
model Stream {
  streamId      BigInt   @id
  sender        String
  recipient     String
  // ... existing fields ...
  
  // New field
  description   String?  // Optional description
}
```

### Step 2: Generate the Migration

Run the migration command with a descriptive name:

```bash
npx prisma migrate dev --name add_description_to_streams
```

**What this does:**
1. Compares `schema.prisma` to the current database state
2. Generates SQL migration files in `prisma/migrations/<timestamp>_add_description_to_streams/`
3. Applies the migration to your local database
4. Regenerates the Prisma Client with the updated types

**Alternative (shorthand):**
```bash
npm run prisma:migrate
```

This runs `prisma migrate dev` and prompts you for a migration name.

### Step 3: Review the Migration

Check the generated SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Stream" ADD COLUMN "description" TEXT;
```

**Important:** Review the SQL before committing. Prisma usually generates correct migrations, but complex schema changes may require manual adjustments.

### Step 4: Commit the Migration

Commit both the schema change and the generated migration:

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add description field to Stream model"
```

## Applying Migrations

### Development (Local)

Migrations are applied automatically when you run:

```bash
npx prisma migrate dev
```

This is already wired into the `npm run prisma:migrate` script.

### Production / CI

Use the `migrate deploy` command, which applies pending migrations without prompting:

```bash
npx prisma migrate deploy
```

This command:
- Applies all unapplied migrations in order
- Does NOT create new migrations
- Does NOT regenerate the Prisma Client (do that at build time)
- Fails if the migrations directory is out of sync with the database

**When to use:**
- Production deployments
- CI/CD pipelines
- Docker container startup

The `Dockerfile` in this repository runs `prisma migrate deploy` automatically when the container starts.

### Docker Compose

When using `docker compose up`, migrations are applied automatically by the `api` service's entrypoint. No manual intervention is needed.

## Typical Workflow

### Scenario 1: Adding a New Field

```bash
# 1. Edit prisma/schema.prisma
vim prisma/schema.prisma

# 2. Generate and apply migration
npx prisma migrate dev --name add_new_field

# 3. Verify the migration
cat prisma/migrations/<timestamp>_add_new_field/migration.sql

# 4. Commit
git add prisma/
git commit -m "feat: add new field to model"
```

### Scenario 2: Renaming a Field

Prisma may generate a DROP + ADD instead of a RENAME. To preserve data, manually adjust the migration SQL:

```bash
# 1. Edit schema (rename field)
# 2. Generate migration
npx prisma migrate dev --name rename_field

# 3. Edit the migration SQL to use ALTER TABLE ... RENAME COLUMN
vim prisma/migrations/<timestamp>_rename_field/migration.sql

# 4. Re-apply
npx prisma migrate resolve --applied <timestamp>_rename_field
npx prisma generate
```

### Scenario 3: Rolling Back a Migration (Development Only)

If you applied a bad migration locally and haven't pushed it:

```bash
# Reset the database to the last good state
npx prisma migrate reset

# This will:
# - Drop the database
# - Recreate it
# - Re-apply all migrations
# - Re-run seed data (if configured)
```

**Warning:** `migrate reset` is destructive. Only use it in development.

## Best Practices

1. **Name migrations descriptively:** Use `add_field_name`, `create_table_name`, `remove_index`, etc.
2. **Review generated SQL:** Prisma is smart, but not perfect. Check complex migrations.
3. **Test migrations locally first:** Apply migrations in dev before pushing.
4. **Commit migrations with schema changes:** The `.prisma` file and the `migrations/` folder should be committed together.
5. **Never edit applied migrations:** Once a migration is applied and pushed, treat it as immutable. Create a new migration to fix issues.
6. **Use `migrate deploy` in production:** Never use `migrate dev` in production — it can prompt for input and is not idempotent.
7. **Mark destructive statements explicitly:** Migrations that drop tables, columns, indexes, or change column types in a way that could cause data loss must include a `-- destructive: <justification>` comment. This policy is enforced by `tests/migrations-safety.test.ts`.

## Destructive Migration Policy

A **forward-only migration policy** is enforced to prevent accidental data loss. Destructive statements such as `DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN ... TYPE`, or `DELETE FROM` must carry an explicit justification comment in the migration SQL.

### Marking Destructive Statements

When a migration includes a destructive operation, add a comment on the same line or immediately before the statement:

```sql
-- destructive: removing legacy table no longer used after v2.0 migration
DROP TABLE old_legacy_data;
```

```sql
-- destructive: column was replaced by normalizedAddress in v3.0
ALTER TABLE "Stream" DROP COLUMN "legacyAddress";
```

The comment must follow this format:
- Start with `-- destructive:`
- Include a brief justification explaining why the destructive change is safe or necessary

### What Counts as Destructive

The following SQL patterns are considered destructive and require a justification:

- `DROP TABLE`
- `DROP COLUMN`
- `DROP INDEX`
- `DROP CONSTRAINT`
- `ALTER TABLE ... DROP`
- `ALTER COLUMN ... TYPE` (type changes that could truncate or lose data)
- `ALTER COLUMN ... SET NOT NULL` (could fail if existing rows have NULL values)
- `TRUNCATE`
- `DELETE FROM`

### Why This Policy Exists

Destructive statements can:
- Cause irreversible data loss in production
- Break rollback compatibility with the previous application version
- Fail when applied to a live database with existing data

By requiring an explicit marker, the policy ensures that destructive changes are:
1. **Deliberate:** The developer consciously chose to make the change
2. **Documented:** The justification is in the migration file for reviewers and operators
3. **Auditable:** A future operator can see why the change was made

### Testing

The migration safety policy is enforced by an automated test:

```bash
npm test tests/migrations-safety.test.ts
```

This test scans all migration files in `prisma/migrations/` and fails if any destructive statement lacks a `-- destructive:` comment.

### Example: Safe Destructive Migration

```sql
-- AlterTable: remove legacy field after data migration to new schema
-- destructive: legacyAmount was fully migrated to normalizedAmount in v4.0
ALTER TABLE "Stream" DROP COLUMN "legacyAmount";
```

Without the `-- destructive:` comment, this migration would fail CI and be blocked from merging.

### Example: Non-Destructive Migration (No Marker Needed)

```sql
-- CreateIndex
CREATE INDEX "Stream_token_idx" ON "Stream"("token");

-- AlterTable
ALTER TABLE "Stream" ADD COLUMN "description" TEXT;
```

These statements are additive and require no marker.

## Common Issues

### Issue 1: "Migration is not in the migrations directory"

**Cause:** Your local migrations folder is out of sync with the database's `_prisma_migrations` table.

**Solution:**
```bash
# Pull the latest migrations
git pull

# Apply missing migrations
npx prisma migrate deploy
```

### Issue 2: "Schema drift detected"

**Cause:** Manual database changes were made outside Prisma's migration system, or migration SQL diverges from `schema.prisma`.

**Checking for Drift:**
To check whether the database or migration history has drifted from `schema.prisma`:
```bash
# Check drift between database and schema.prisma
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script

# Check drift between migration files and schema.prisma
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script
```
If the command produces no SQL output, there is no drift. Any printed SQL indicates divergence that must be addressed.

**Solution:**
```bash
# Option 1: Create a new migration to match the drift
npx prisma migrate dev --name sync_manual_changes

# Option 2: Reset dev database (destructive)
npx prisma migrate reset
```

### Issue 3: Prisma Client types are stale after migration

**Cause:** The migration was applied, but the Prisma Client wasn't regenerated.

**Solution:**
```bash
npx prisma generate
```

Or use the npm script:
```bash
npm run prisma:generate
```

## Migration Commands Reference

| Command | Use Case | Safe for Production? |
|---------|----------|----------------------|
| `prisma migrate dev` | Create and apply migrations locally | ❌ No |
| `prisma migrate deploy` | Apply pending migrations | ✅ Yes |
| `prisma migrate reset` | Reset database and re-apply all migrations | ❌ No (destructive) |
| `prisma migrate resolve` | Mark a migration as applied/rolled-back | ⚠️ Use with caution |
| `prisma migrate status` | Check which migrations are pending | ✅ Yes (read-only) |
| `prisma generate` | Regenerate Prisma Client | ✅ Yes |

## Integration with npm Scripts

The project's `package.json` includes these convenience scripts:

```json
{
  "scripts": {
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev"
  }
}
```

- `npm run prisma:generate`: Regenerate Prisma Client types (after pulling schema changes)
- `npm run prisma:migrate`: Create and apply a new migration (development only)

## Further Reading

- [Prisma Migrate Documentation](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [Migration Troubleshooting](https://www.prisma.io/docs/guides/migrate/troubleshooting-development)
- [Production Best Practices](https://www.prisma.io/docs/guides/deployment/deploy-database-changes-with-prisma-migrate)
