import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import {
  STREAM_VIEW_SCHEMA_ID,
  STREAM_LIST_RESPONSE_SCHEMA_ID,
  STREAM_SUMMARY_RESPONSE_SCHEMA_ID,
  INDEXER_STATUS_SCHEMA_ID,
  ERROR_SCHEMA_ID,
} from "../src/schema.js";

describe("OpenAPI Schema Identifiers", () => {
  it("should expose shared schemas as named components matching their identifiers", async () => {
    const app = await buildServer();
    await app.ready();
    const swaggerDoc = app.swagger();

    const expectedIdentifiers = [
      STREAM_VIEW_SCHEMA_ID,
      STREAM_LIST_RESPONSE_SCHEMA_ID,
      STREAM_SUMMARY_RESPONSE_SCHEMA_ID,
      INDEXER_STATUS_SCHEMA_ID,
      ERROR_SCHEMA_ID,
    ];

    const actualKeys = Object.keys((swaggerDoc as any).components?.schemas ?? {});

    for (const expectedId of expectedIdentifiers) {
      expect(actualKeys).toContain(expectedId);
    }
    
    // It should also exactly match these keys (or fail if new ones are added or names change)
    // Actually the prompt says: "structured so the test fails if any identifier changes (e.g. a snapshot of expected names, or explicit assertions against the generated spec's component keys)."
    expect(actualKeys.sort()).toEqual(expectedIdentifiers.sort());
  });
});
