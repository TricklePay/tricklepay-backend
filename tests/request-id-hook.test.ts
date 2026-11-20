import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { REQUEST_ID_HEADER, sanitizeRequestId } from "../src/request-id.js";
import { registerRequestIdHook } from "../src/request-id-hook.js";
import { buildServer } from "../src/server.js";

// Direct tests for the request id echo hook (#712). The first block mounts the
// hook on a bare Fastify instance, wired the same way as `buildServer`, so each
// response class is checked against the hook alone. The second block goes
// through `buildServer` to prove early responses from other onRequest hooks
// (the rate limiter and the query-string guard) also carry the header.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function bareApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: (req) => sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID(),
  });
  apps.push(app);

  registerRequestIdHook(app);

  // A later hook that answers before routing, like the rate limiter does.
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["x-short-circuit"]) {
      return reply.status(503).send({ error: "sent from another hook" });
    }
  });

  app.get("/ok", async () => ({ ok: true }));
  app.get("/whoami", async (request) => ({ id: request.id }));
  app.get(
    "/validated",
    { schema: { querystring: { type: "object", properties: { n: { type: "integer" } } } } },
    async () => ({ ok: true }),
  );
  app.get("/boom", async () => {
    throw new Error("boom");
  });
  app.get("/too-many", async (_request, reply) => reply.status(429).send({ error: "slow down" }));

  await app.ready();
  return app;
}

async function serverApp(options: Parameters<typeof buildServer>[0] = {}) {
  const app = await buildServer(options);
  apps.push(app);
  await app.ready();
  return app;
}

describe("registerRequestIdHook", () => {
  it.each([
    { label: "200 success", url: "/ok", status: 200 },
    { label: "400 validation error", url: "/validated?n=abc", status: 400 },
    { label: "404 unmatched route", url: "/missing", status: 404 },
    { label: "429 from a handler", url: "/too-many", status: 429 },
    { label: "500 thrown error", url: "/boom", status: 500 },
  ])("sets the header on a $label", async ({ url, status }) => {
    const app = await bareApp();

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(status);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("sets the header on a response sent from a later hook", async () => {
    const app = await bareApp();

    const response = await app.inject({
      method: "GET",
      url: "/ok",
      headers: { "x-short-circuit": "1" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("echoes the request.id that Fastify assigned", async () => {
    const app = await bareApp();

    const response = await app.inject({ method: "GET", url: "/whoami" });

    expect(response.headers[REQUEST_ID_HEADER]).toBe(response.json<{ id: string }>().id);
  });

  it("generates a distinct id per request", async () => {
    const app = await bareApp();

    const first = await app.inject({ method: "GET", url: "/ok" });
    const second = await app.inject({ method: "GET", url: "/ok" });

    expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
  });

  it.each(["/ok", "/missing", "/boom"])("echoes a valid client-supplied id on %s", async (url) => {
    const app = await bareApp();

    const response = await app.inject({
      method: "GET",
      url,
      headers: { [REQUEST_ID_HEADER]: "client-trace-42" },
    });

    expect(response.headers[REQUEST_ID_HEADER]).toBe("client-trace-42");
  });

  it.each([
    { label: "unsafe characters", id: "bad id;drop" },
    { label: "a leading separator", id: "-leading" },
    { label: "an oversized value", id: "a".repeat(65) },
  ])("replaces a client id with $label", async ({ id }) => {
    const app = await bareApp();

    const response = await app.inject({
      method: "GET",
      url: "/ok",
      headers: { [REQUEST_ID_HEADER]: id },
    });

    expect(response.headers[REQUEST_ID_HEADER]).not.toBe(id);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });
});

describe("request id header on responses from other server hooks", () => {
  it("is present on 429 responses from the rate limiter", async () => {
    const app = await serverApp({ rateLimitMax: 1 });

    const allowed = await app.inject({ method: "GET", url: "/missing" });
    const limited = await app.inject({
      method: "GET",
      url: "/missing",
      headers: { [REQUEST_ID_HEADER]: "client-trace-429" },
    });

    expect(allowed.statusCode).toBe(404);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers[REQUEST_ID_HEADER]).toBe("client-trace-429");
    expect(limited.json()).toMatchObject({ requestId: "client-trace-429" });
  });

  it("is replaced with a generated id on a rate-limited request with an invalid id", async () => {
    const app = await serverApp({ rateLimitMax: 0 });

    const limited = await app.inject({
      method: "GET",
      url: "/missing",
      headers: { [REQUEST_ID_HEADER]: "not valid!" },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("is present on 400 responses from the repeated query parameter guard", async () => {
    const app = await serverApp();

    const response = await app.inject({ method: "GET", url: "/health?a=1&a=2" });

    expect(response.statusCode).toBe(400);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
    expect(response.json()).toMatchObject({
      requestId: response.headers[REQUEST_ID_HEADER],
    });
  });

  it("is present on 400 responses from the query string length guard", async () => {
    const app = await serverApp({ queryStringLimit: 4 });

    const response = await app.inject({ method: "GET", url: "/health?abcdefgh=1" });

    expect(response.statusCode).toBe(400);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });
});
