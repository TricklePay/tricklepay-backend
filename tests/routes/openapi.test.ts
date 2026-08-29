import { describe, expect, it } from "vitest";

import { vi } from "vitest";

import { statusRoutes } from "../../src/routes/status.js";

import { streamRoutes } from "../../src/routes/streams.js";

import { buildServer } from "../../src/server.js";

async function getSpec() {
  const app = await buildServer();
  await app.register(streamRoutes);
  await app.register(statusRoutes);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/docs/json" });
  await app.close();

  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

describe("GET /docs/json (OpenAPI spec)", () => {
  it("responds with 200 and application/json content-type", async () => {
    const app = await buildServer();
    await app.register(streamRoutes);
    await app.register(statusRoutes);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/docs/json" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("declares openapi 3.0.x", async () => {
    const spec = await getSpec();
    expect((spec.openapi as string)).toMatch(/^3\.0\./);
  });

  it("includes info title and version", async () => {
    const spec = await getSpec();
    const info = spec.info as { title: string; version: string };
    expect(info.title).toBe("TricklePay API");
    expect(info.version).toBeTruthy();
  });

  it("documents the GET /streams path", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/streams");
    expect((paths["/streams"] as Record<string, unknown>)).toHaveProperty("get");
  });

  it("documents the GET /streams/:id path", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/streams/{id}");
  });

  it("documents the GET /streams/summary path", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/streams/summary");
    expect((paths["/streams/summary"] as Record<string, unknown>)).toHaveProperty("get");
  });

  it("documents the GET /status path", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/status");
  });

  it("documents the GET /health path", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/health");
  });

  it("exports StreamView as a reusable component schema", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    expect(schemas).toHaveProperty("StreamView");
  });

  it("StreamView includes the fields that the frontend was missing", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    const streamView = schemas["StreamView"] as {
      properties?: Record<string, unknown>;
    };
    expect(streamView?.properties).toHaveProperty("locked");
    expect(streamView?.properties).toHaveProperty("progress");
    expect(streamView?.properties).toHaveProperty("vested");
    expect(streamView?.properties).toHaveProperty("withdrawable");
  });

  it("StreamListResponse includes pagination fields total, limit, offset", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    const listSchema = schemas["StreamListResponse"] as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(listSchema?.properties).toHaveProperty("total");
    expect(listSchema?.properties).toHaveProperty("limit");
    expect(listSchema?.properties).toHaveProperty("offset");
    expect(listSchema?.properties).toHaveProperty("streams");
  });

  it("StreamListResponse exposes nextCursor for opaque cursor pagination", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    const listSchema = schemas["StreamListResponse"] as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(listSchema?.properties).toHaveProperty("nextCursor");
    expect(listSchema?.required).not.toContain("nextCursor");
  });

  it("StreamListResponse.total is optional so both response variants are valid", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    const listSchema = schemas["StreamListResponse"] as { required?: string[] };
    expect(listSchema?.required).not.toContain("total");
  });

  it("documents the includeTotal query parameter on GET /streams", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    const params = (paths["/streams"]?.get as { parameters?: Array<Record<string, unknown>> })
      ?.parameters ?? [];
    const names = params.map((p) => p.name);
    expect(names).toContain("includeTotal");
    expect(names).toContain("offset");
  });

  it("documents the cancelled query parameter on GET /streams", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    const params = (paths["/streams"]?.get as { parameters?: Array<Record<string, unknown>> })
      ?.parameters ?? [];
    const cancelledParam = params.find((p) => p.name === "cancelled");
    expect(cancelledParam).toBeDefined();
    expect((cancelledParam as { schema?: { enum?: string[] } })?.schema?.enum).toEqual(
      expect.arrayContaining(["true", "false"]),
    );
  });

  it("documents the cursor query parameter on GET /streams", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    const params = (paths["/streams"]?.get as { parameters?: Array<Record<string, unknown>> })
      ?.parameters ?? [];
    const cursorParam = params.find((p) => p.name === "cursor");
    expect(cursorParam).toBeDefined();
    expect((cursorParam as { description?: string })?.description).toMatch(/cursor|opaque/i);
  });

  it("exports StreamSummaryResponse as a reusable component schema", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    expect(schemas).toHaveProperty("StreamSummaryResponse");
    const summary = schemas["StreamSummaryResponse"] as {
      properties?: Record<string, unknown>;
    };
    for (const status of ["pending", "streaming", "completed", "cancelled"]) {
      expect(summary?.properties).toHaveProperty(status);
    }
  });

  it("exports IndexerStatus as a reusable component schema", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    expect(schemas).toHaveProperty("IndexerStatus");
  });

  it("exports ApiError as a reusable component schema", async () => {
    const spec = await getSpec();
    const schemas = (
      spec.components as { schemas?: Record<string, unknown> }
    )?.schemas ?? {};
    expect(schemas).toHaveProperty("ApiError");
  });

  it("GET /streams/:id declares 404 response", async () => {
    const spec = await getSpec();
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    const getById = paths["/streams/{id}"]?.get as {
      responses?: Record<string, unknown>;
    };
    expect(getById?.responses).toHaveProperty("404");
  });
});

describe("GET /docs/yaml (OpenAPI spec — YAML)", () => {
  it("responds with 200 and YAML content type", async () => {
    const app = await buildServer();
    await app.register(streamRoutes);
    await app.register(statusRoutes);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/docs/yaml" });
    await app.close();

    expect(response.statusCode).toBe(200);
    // YAML variant should not be JSON
    expect(response.headers["content-type"]).toContain("yaml");
    // A minimal sanity check: the body starts with the openapi version line.
    expect(response.body).toContain("openapi:");
    expect(response.body).toContain("TricklePay API");
  });
});
