// Registers the GET / endpoint.
// This route returns a static API index and does not read from the database.

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

import { API_INDEX_SCHEMA_ID, apiIndexSchema } from "../schema.js";

const DESCRIPTIONS: Record<string, string> = {
  "GET /": "API index",
  "GET /health": "Liveness check",
  "GET /ready": "Readiness check",
  "GET /status": "Indexer progress",
  "GET /metrics": "Prometheus metrics",
  "GET /streams": "List streams; filters: sender, recipient, token, limit, offset, cursor, cancelled, includeTotal, fields",
  "GET /streams/summary": "Summarize streams by status",
  "GET /streams/:id": "A single stream by id",
  "GET /streams/:id/events": "Stream event history",
  "GET /streams/:id/schedule": "Get stream vesting schedule; parameters: points",
  "GET /streams/:id/updates": "Subscribe to stream updates",
  "GET /accounts/:address/summary": "Get account stream summary",
  "GET /tokens": "List distinct tokens",
  "POST /admin/replay": "Trigger failed event replay (admin)",
};

const FALLBACK_ENDPOINTS = Object.entries(DESCRIPTIONS).map(([key, description]) => {
  const [method, ...pathParts] = key.split(" ");
  return { method, path: pathParts.join(" "), description };
});

// A self-describing index of the API, so a caller hitting the root learns what
// endpoints exist without reading the source.
export function rootRoutes(config: Config) {
  return async (app: FastifyInstance): Promise<void> => {
    if (!app.getSchema(API_INDEX_SCHEMA_ID)) app.addSchema(apiIndexSchema);
    if (!app.hasDecorator("apiRoutes")) {
      app.decorate("apiRoutes", [] as Array<{ method: string; url: string; schema?: { hide?: boolean } }>);
      app.addHook("onRoute", (route) => {
        app.apiRoutes.push({ method: route.method as string, url: route.url, schema: route.schema as { hide?: boolean } | undefined });
      });
    }
    app.get("/", { schema: { response: { 200: { $ref: API_INDEX_SCHEMA_ID } } } }, async (request) => {
      // Determine if we're on the /v1 prefix by checking the path
      const isV1 = request.routeOptions.url?.startsWith("/v1") ?? false;
      const prefix = isV1 ? "/v1" : "";
      
      const discovered = app.apiRoutes
        .filter((route) => route.method !== "HEAD" && !route.schema?.hide)
        .filter((route) => isV1 ? route.url.startsWith("/v1/") || route.url === "/v1" : !route.url.startsWith("/v1/") && !route.url.startsWith("/docs"))
        .map((route) => ({
          method: route.method,
          path: route.url,
          description: DESCRIPTIONS[`${route.method} ${route.url.replace(/^\/v1/, "")}`] ?? "API endpoint",
        }));
      const endpoints = discovered.length > 1 ? discovered : FALLBACK_ENDPOINTS.filter((endpoint) =>
        isV1 ? endpoint.path !== "/" && endpoint.path !== "/health" : true,
      ).map((endpoint) => ({
        ...endpoint,
        path: isV1 ? `/v1${endpoint.path}` : endpoint.path,
      }));
      if (!isV1) endpoints.push({ method: "GET", path: "/docs", description: "Interactive OpenAPI documentation" });

      return {
        name: "tricklepay-backend",
        description: "Indexer and read API for TricklePay token streams",
        version: isV1 ? "v1" : "unversioned (deprecated)",
        network: config.network,
        contractId: config.contractId,
        endpoints,
      };
    });
  };
}
