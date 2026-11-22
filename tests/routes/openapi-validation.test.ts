import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import { metricsRoutes } from "../../src/routes/metrics.js";
import { rootRoutes } from "../../src/routes/root.js";
import { statusRoutes } from "../../src/routes/status.js";
import { streamRoutes } from "../../src/routes/streams.js";
import { buildServer } from "../../src/server.js";

// The validator's own document type, so the test needs no direct dependency on
// `openapi-types`.
type OpenApiDocument = SwaggerParser["api"];

// Validates the served OpenAPI document against the OpenAPI 3.0 JSON Schema
// (#714). `openapi.test.ts` checks individual routes and metadata; this test
// catches structural problems client generators would trip over: dangling
// $refs, invalid response keys, and keywords OpenAPI 3.0 does not support.
// It runs with the docs UI on and off, since the document is served by
// different code in each mode (#521). No database is needed: the routes are
// registered but never called.

async function fetchSpec(enableDocsUi: boolean): Promise<OpenApiDocument> {
  const app = await buildServer({ enableDocsUi });
  await app.register(rootRoutes({ network: "testnet", contractId: "C123" } as never));
  await app.register(streamRoutes);
  await app.register(statusRoutes);
  await app.register(metricsRoutes, { token: undefined });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/docs/json" });
  await app.close();

  expect(response.statusCode).toBe(200);
  return response.json() as OpenApiDocument;
}

/**
 * Runs the validator and returns its error message, or `undefined` when the
 * document is valid. The validator dereferences in place, so it gets a copy.
 */
async function validationError(spec: OpenApiDocument): Promise<string | undefined> {
  try {
    await SwaggerParser.validate(structuredClone(spec));
    return undefined;
  } catch (error) {
    const details = (error as { details?: unknown }).details;
    const message = error instanceof Error ? error.message : String(error);
    return details === undefined ? message : `${message}\n${JSON.stringify(details, null, 2)}`;
  }
}

describe.each([
  { label: "docs UI enabled", enableDocsUi: true },
  { label: "docs UI disabled", enableDocsUi: false },
])("OpenAPI document validity ($label)", ({ enableDocsUi }) => {
  it("is a valid OpenAPI 3.0 document", async () => {
    const spec = await fetchSpec(enableDocsUi);

    expect((spec as { openapi?: string }).openapi).toMatch(/^3\.0\./);
    // Printing the validator's message (which lists each schema violation)
    // as the assertion message makes a failure self-explanatory.
    const error = await validationError(spec);
    expect(error, error).toBeUndefined();
  });
});

describe("OpenAPI validator", () => {
  // Sanity check that the validator is actually wired up and reports errors,
  // so the tests above cannot pass because validation silently did nothing.
  it("rejects a document with a dangling $ref and reports it", async () => {
    const spec = await fetchSpec(true);
    const broken = structuredClone(spec) as { paths: Record<string, Record<string, unknown>> };
    broken.paths["/__broken"] = {
      get: {
        responses: {
          "200": {
            description: "broken",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/DoesNotExist" } },
            },
          },
        },
      },
    };

    const error = await validationError(broken as unknown as OpenApiDocument);
    expect(error).toBeDefined();
    expect(error).toContain("DoesNotExist");
  });

  it("rejects a document with an invalid response key", async () => {
    const spec = await fetchSpec(true);
    const broken = structuredClone(spec) as { paths: Record<string, Record<string, unknown>> };
    broken.paths["/__broken"] = {
      get: { responses: { "not-a-status": { description: "broken" } } },
    };

    expect(await validationError(broken as unknown as OpenApiDocument)).toBeDefined();
  });
});
