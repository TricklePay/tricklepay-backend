import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const enabled = !!process.env.DATABASE_URL;

describe("Prisma migration drift", () => {
  it.skipIf(!enabled)("keeps the migration history in sync with schema.prisma", () => {
    const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;
    expect(
      shadowDatabaseUrl,
      "Set SHADOW_DATABASE_URL to a separate, disposable Postgres database; never use DATABASE_URL.",
    ).toBeTruthy();

    const cli = resolve("node_modules/prisma/build/index.js");
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "migrate",
        "diff",
        "--from-migrations",
        resolve("prisma/migrations"),
        "--to-schema-datamodel",
        resolve("prisma/schema.prisma"),
        "--shadow-database-url",
        shadowDatabaseUrl!,
        "--script",
        "--exit-code",
      ],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    expect(
      result.status,
      `Prisma migration drift check failed. Generated SQL and diagnostics:\n${output}`,
    ).toBe(0);
  });
});
