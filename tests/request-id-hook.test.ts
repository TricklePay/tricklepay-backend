import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { REQUEST_ID_HEADER } from "../src/request-id.js";
import { registerRequestIdHook } from "../src/request-id-hook.js";
import { buildServer } from "../src/server.js";

// The request-id hook (#712) must echo `x-request-id` on every response class:
// success, 404, 400, 429 and 500, including replies sent by other hooks before
// routing finishes. The first block exercises the hook on a bare Fastify
// instance so nothing else in the server can set the header; the second runs
// it inside the real server for client-supplied ids and the rate limiter.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function bareApp(): Promise<FastifyInstance> {
  let next = 0;
  const instance = Fastify({ logger: false, genReqId: () => `req-${++next}` });
  // Registered before the request-id hook, so an onRequest-only hook would
  // never run for these replies.
  instance.addHook("onRequest", async (request, reply) => {
    if (request.url === "/blocked-by-hook") {
      return reply.status(403).send({ error: "blocked" });
    }
  });
  registerRequestIdHook(instance);
  instance.get("/ok", async () => ({ ok: true }));
  instance.get(
    "/validated",
    { schema: { querystring: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } } },
    async () => ({ ok: true }),
  );
  instance.get("/boom", async () => {
    throw new Error("boom");
  });
  instance.get("/too-many", async (_request, reply) =>
    reply.status(429).send({ error: "rate limit exceeded" }),
  );
  await instance.ready();
  return instance;
}

describe("registerRequestIdHook on a bare instance", () => {
  const cases = [
    { name: "a 200 success", url: "/ok", status: 200 },
    { name: "a 404 unmatched route", url: "/missing", status: 404 },
    { name: "a 400 validation error", url: "/validated?n=abc", status: 400 },
    { name: "a 429 response", url: "/too-many", status: 429 },
    { name: "a 500 thrown error", url: "/boom", status: 500 },
    { name: "a reply sent from an earlier onRequest hook", url: "/blocked-by-hook", status: 403 },
  ];

  it.each(cases)("sets the header on $name", async ({ url, status }) => {
    app = await bareApp();
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(status);
    expect(response.headers[REQUEST_ID_HEADER]).toBe("req-1");
  });

  it("echoes the id of each request, not a shared value", async () => {
    app = await bareApp();
    const first = await app.inject({ method: "GET", url: "/ok" });
    const second = await app.inject({ method: "GET", url: "/missing" });
    expect(first.headers[REQUEST_ID_HEADER]).toBe("req-1");
    expect(second.headers[REQUEST_ID_HEADER]).toBe("req-2");
  });
});

describe("request-id hook in the full server", () => {
  it("echoes a valid client-supplied id", async () => {
    app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { [REQUEST_ID_HEADER]: "client-trace-42" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers[REQUEST_ID_HEADER]).toBe("client-trace-42");
  });

  it("replaces an invalid client-supplied id with a generated uuid", async () => {
    app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { [REQUEST_ID_HEADER]: "not valid; id" },
    });
    expect(response.headers[REQUEST_ID_HEADER]).not.toBe("not valid; id");
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
  });

  it("sets the header on 429 responses from the rate limiter", async () => {
    app = await buildServer({ rateLimitMax: 1 });
    const headers = { [REQUEST_ID_HEADER]: "trace-limited" };
    const allowed = await app.inject({ method: "GET", url: "/nope", headers });
    const limited = await app.inject({ method: "GET", url: "/nope", headers });

    expect(allowed.statusCode).toBe(404);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers[REQUEST_ID_HEADER]).toBe("trace-limited");
    expect(limited.json()).toMatchObject({ requestId: "trace-limited" });
  });

  it("sets a generated id on 429 responses when the client sent none", async () => {
    app = await buildServer({ rateLimitMax: 1 });
    await app.inject({ method: "GET", url: "/nope" });
    const limited = await app.inject({ method: "GET", url: "/nope" });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers[REQUEST_ID_HEADER]).toMatch(UUID_PATTERN);
    expect(limited.headers[REQUEST_ID_HEADER]).toBe(limited.json().requestId);
  });

  it("sets the header on 400 responses from the query-string hook", async () => {
    app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health?a=1&a=2",
      headers: { [REQUEST_ID_HEADER]: "trace-repeated" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers[REQUEST_ID_HEADER]).toBe("trace-repeated");
  });

  it("sets the header on 404 responses from the not-found handler", async () => {
    app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(response.json().requestId);
  });
});
