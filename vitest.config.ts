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
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/integration/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
        },
      },
    ],
  },
});
