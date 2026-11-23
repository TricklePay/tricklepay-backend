import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

// This test enforces a forward-only migration policy: destructive statements
// such as DROP TABLE, DROP COLUMN, or type changes that could cause data loss
// must carry an explicit `-- destructive: <justification>` comment. Without
// the marker, the test fails, blocking the migration from being merged.
//
// The goal is to make destructive changes deliberate and documented, so an
// operator reviewing the migration can see the reasoning and assess the impact
// before deploying it.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = join(__dirname, "..", "prisma", "migrations");

// Patterns that indicate a destructive statement. Each is a regex that matches
// SQL statements known to cause data loss or schema incompatibility.
const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /\bALTER\s+TABLE\s+.*\s+DROP\b/i,
  /\bALTER\s+COLUMN\s+.*\s+TYPE\b/i,
  /\bALTER\s+COLUMN\s+.*\s+SET\s+NOT\s+NULL\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
];

// A comment that justifies a destructive statement. The migration author must
// write `-- destructive: <reason>` on the line before or on the same line as
// the destructive statement.
const DESTRUCTIVE_MARKER = /--\s*destructive:\s*.+/i;

function getMigrationFiles(): string[] {
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(migrationsDir, entry.name, "migration.sql"))
    .filter((path) => {
      try {
        readFileSync(path, "utf-8");
        return true;
      } catch {
        return false;
      }
    });
  return migrations;
}

function parseStatements(sql: string): Array<{ sql: string; line: number }> {
  // Split the SQL file into statements. A naive split on semicolons is good
  // enough for Prisma-generated migrations, which do not contain semicolons
  // inside strings or comments in a way that would break this.
  const lines = sql.split("\n");
  const statements: Array<{ sql: string; line: number }> = [];
  let currentStatement = "";
  let statementStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentStatement += line + "\n";

    if (line.trim().endsWith(";")) {
      statements.push({ sql: currentStatement.trim(), line: statementStartLine });
      currentStatement = "";
      statementStartLine = i + 2; // Next line (1-indexed)
    }
  }

  // Catch any trailing statement without a semicolon
  if (currentStatement.trim().length > 0) {
    statements.push({ sql: currentStatement.trim(), line: statementStartLine });
  }

  return statements;
}

function isDestructive(sql: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(sql));
}

function hasDestructiveMarker(sql: string): boolean {
  return DESTRUCTIVE_MARKER.test(sql);
}

describe("migration safety", () => {
  it("rejects destructive statements without a justification marker", () => {
    const migrations = getMigrationFiles();
    expect(migrations.length).toBeGreaterThan(0); // Ensure we are testing something

    const violations: Array<{ file: string; line: number; statement: string }> = [];

    for (const migrationPath of migrations) {
      const sql = readFileSync(migrationPath, "utf-8");
      const statements = parseStatements(sql);

      for (const { sql: statement, line } of statements) {
        if (isDestructive(statement) && !hasDestructiveMarker(statement)) {
          violations.push({
            file: migrationPath,
            line,
            statement: statement.split("\n")[0], // First line for brevity
          });
        }
      }
    }

    if (violations.length > 0) {
      const message = violations
        .map(
          ({ file, line, statement }) =>
            `${file}:${line}\n  ${statement}\n  Missing: -- destructive: <justification>`
        )
        .join("\n\n");
      throw new Error(`Destructive statements without justification:\n\n${message}`);
    }
  });

  it("allows destructive statements with a justification marker", () => {
    // A synthetic test to confirm the marker is recognized. In practice, this
    // would be a real migration file with a justified destructive statement.
    const sql = `
-- destructive: removing unused legacy table
DROP TABLE old_legacy_data;
    `;

    const statements = parseStatements(sql);
    expect(statements.length).toBe(1);
    expect(isDestructive(statements[0].sql)).toBe(true);
    expect(hasDestructiveMarker(statements[0].sql)).toBe(true);
  });

  it("allows non-destructive migrations without a marker", () => {
    const sql = `
CREATE TABLE "NewTable" (
    "id" SERIAL PRIMARY KEY,
    "name" TEXT NOT NULL
);

CREATE INDEX "NewTable_name_idx" ON "NewTable"("name");
    `;

    const statements = parseStatements(sql);
    for (const { sql: statement } of statements) {
      expect(isDestructive(statement)).toBe(false);
    }
  });

  it("existing migrations pass the destructive check", () => {
    // All current migrations in the repository must pass. If this test fails,
    // a migration was added with a destructive statement but no marker, or a
    // new destructive pattern was added to the list and an existing migration
    // needs a retroactive marker.
    const migrations = getMigrationFiles();
    expect(migrations.length).toBeGreaterThan(0);

    for (const migrationPath of migrations) {
      const sql = readFileSync(migrationPath, "utf-8");
      const statements = parseStatements(sql);

      for (const { sql: statement } of statements) {
        if (isDestructive(statement)) {
          expect(
            hasDestructiveMarker(statement),
            `Migration ${migrationPath} contains destructive statement without marker:\n${statement}`
          ).toBe(true);
        }
      }
    }
  });
});
