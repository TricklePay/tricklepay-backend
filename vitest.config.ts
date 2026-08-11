import { defineConfig } from "vitest/config";

// Tests live outside `src` so the build output stays free of them and the
// existing `tsconfig.json` needs no exclusions. `tsconfig.test.json` type
// checks them; Vitest itself only transpiles.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
