import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportOpenApiSpec } from "../../scripts/export-openapi.js";

describe("OpenAPI export script (#778)", () => {
  const testOutputPath = resolve("test-openapi-output.json");

  afterAll(() => {
    if (existsSync(testOutputPath)) {
      unlinkSync(testOutputPath);
    }
  });

  it("exports a valid OpenAPI 3.0 specification file", async () => {
    await exportOpenApiSpec(testOutputPath);

    expect(existsSync(testOutputPath)).toBe(true);

    const content = JSON.parse(readFileSync(testOutputPath, "utf-8"));
    expect(content.openapi).toBe("3.0.3");
    expect(content.info).toBeDefined();
    expect(content.info.title).toBeDefined();
    expect(content.paths).toBeDefined();
    expect(content.paths["/v1/streams"] || content.paths["/streams"]).toBeDefined();
    expect(content.components).toBeDefined();
    expect(content.components.schemas).toBeDefined();
  });
});
