import { defineConfig } from "vitest/config";

// Tests live outside `src` so the build output stays free of them and the
// existing `tsconfig.json` needs no exclusions. `tsconfig.test.json` type
// checks them; Vitest itself only transpiles.
//
// The default `npm test` runs only the unit project.  The integration project
// requires DATABASE_URL and is opt-in via `npx vitest run --project integration`.
export default defineConfig({
  test: {
    environment: "node",
    // Coverage is only collected when `--coverage` is passed (`npm run
    // test:coverage`, used by CI). No thresholds are enforced yet; the first
    // CI report is the baseline.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        test: {
          name: "unit",
          env: { LOG_LEVEL: "silent" },
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/integration/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Every file shares the one DATABASE_URL, and some clean up with a
          // table-wide deleteMany, so files running in parallel delete each
          // other's rows mid-test. Run them one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
