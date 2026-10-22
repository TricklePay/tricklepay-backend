import { describe, expect, it } from "vitest";

// ENABLE_DOCS_UI (#521): the interactive page is on by default. Turning it off
// must remove the page and its static assets while keeping the machine-readable
// OpenAPI document at the documented paths.

const { buildServer } = await import("../../src/server.js");
const { statusRoutes } = await import("../../src/routes/status.js");
const { streamRoutes } = await import("../../src/routes/streams.js");

async function appWith(enableDocsUi: boolean) {
  const app = await buildServer({ enableDocsUi });
  await app.register(streamRoutes);
  await app.register(statusRoutes);
  await app.ready();
  return app;
}

describe("Swagger UI optional (#521)", () => {
  it("serves the UI at /docs by default", async () => {
    const app = await appWith(true);

    const response = await app.inject({ method: "GET", url: "/docs" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
  });

  it("serves only the spec when the UI is disabled", async () => {
    const app = await appWith(false);

    // The page, its trailing-slash form, and its assets are all gone.
    const ui = await app.inject({ method: "GET", url: "/docs" });
    const trailing = await app.inject({ method: "GET", url: "/docs/" });
    const asset = await app.inject({
      method: "GET",
      url: "/docs/static/swagger-ui-bundle.js",
    });
    expect(ui.statusCode).toBe(404);
    expect(trailing.statusCode).toBe(404);
    expect(asset.statusCode).toBe(404);

    // Both spec formats remain available.
    const json = await app.inject({ method: "GET", url: "/docs/json" });
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-type"]).toContain("application/json");
    const spec = json.json() as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(spec.paths).toHaveProperty("/health");
    expect(spec.paths).toHaveProperty("/streams");

    const yaml = await app.inject({ method: "GET", url: "/docs/yaml" });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers["content-type"]).toContain("yaml");
    expect(yaml.body).toContain("openapi:");

    await app.close();
  });

  it("keeps the hidden spec helper routes out of the document", async () => {
    const app = await appWith(false);

    const response = await app.inject({ method: "GET", url: "/docs/json" });
    await app.close();

    const spec = response.json() as { paths?: Record<string, unknown> };
    expect(spec.paths).not.toHaveProperty("/docs/json");
    expect(spec.paths).not.toHaveProperty("/docs/yaml");
  });
});
