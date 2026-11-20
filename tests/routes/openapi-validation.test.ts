import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import { metricsRoutes } from "../../src/routes/metrics.js";
import { rootRoutes } from "../../src/routes/root.js";
import { statusRoutes } from "../../src/routes/status.js";
import { streamRoutes } from "../../src/routes/streams.js";
import { buildServer } from "../../src/server.js";

// OpenAPI validation (#714): `/docs/json` must be a valid OpenAPI 3.0 document,
// so invalid $refs, wrong response keys, and unsupported keywords are caught
// here before a client generator trips over them. The document is served from
// a different code path when the UI is disabled (#521), so both are checked.

async function fetchSpec(enableDocsUi: boolean): Promise<Record<string, unknown>> {
  const app = await buildServer({ enableDocsUi });
  await app.register(rootRoutes({ network: "testnet", contractId: "C123" } as never));
  await app.register(streamRoutes);
  await app.register(statusRoutes);
  await app.register(metricsRoutes, {});
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/docs/json" });
  await app.close();

  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

/** Formats a validator error, including every nested detail, for the test output. */
function describeValidationError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const details = (err as Error & { details?: unknown }).details;
  return details === undefined
    ? err.message
    : `${err.message}\n${JSON.stringify(details, null, 2)}`;
}

/** Validates `spec`, returning the formatted errors or `undefined` when valid. */
async function validationErrors(spec: Record<string, unknown>): Promise<string | undefined> {
  try {
    // The validator dereferences in place, so give it a copy.
    await SwaggerParser.validate(structuredClone(spec) as never);
    return undefined;
  } catch (err) {
    return describeValidationError(err);
  }
}

describe.each([true, false])("OpenAPI document validity (ENABLE_DOCS_UI=%s)", (enableDocsUi) => {
  it("is a valid OpenAPI 3.0 document", async () => {
    const spec = await fetchSpec(enableDocsUi);
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(await validationErrors(spec)).toBeUndefined();
  });
});

describe("OpenAPI validator", () => {
  it("reports an invalid $ref with its details", async () => {
    const spec = await fetchSpec(true);
    const broken = structuredClone(spec) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const [firstPath] = Object.keys(broken.paths);
    const [firstMethod] = Object.keys(broken.paths[firstPath]);
    broken.paths[firstPath][firstMethod].responses["200"] = {
      description: "broken",
      content: { "application/json": { schema: { $ref: "#/components/schemas/DoesNotExist" } } },
    };

    expect(await validationErrors(broken)).toContain("DoesNotExist");
  });

  it("reports a wrong response key", async () => {
    const spec = await fetchSpec(true);
    const broken = structuredClone(spec) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const [firstPath] = Object.keys(broken.paths);
    const [firstMethod] = Object.keys(broken.paths[firstPath]);
    broken.paths[firstPath][firstMethod].responses["not-a-status"] = { description: "bad key" };

    expect(await validationErrors(broken)).toBeDefined();
  });
});
