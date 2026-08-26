import { describe, expect, it, vi } from "vitest";

// Request ids: every response carries an `x-request-id` header matching the id
// bound to the server's structured logs (`reqId`), a safe client-supplied id is
// forwarded unchanged, and unsafe or oversized ones are replaced. Error bodies
// include the id so a client report can be matched to its log lines.

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", () => streamsRepo);

const { buildServer } = await import("../../src/server.js");
const { streamRoutes } = await import("../../src/routes/streams.js");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function inject(options: {
  url: string;
  headers?: Record<string, string>;
}) {
  const app = await buildServer();
  await app.register(streamRoutes);
  const response = await app.inject({
    method: "GET",
    url: options.url,
    headers: options.headers,
  });
  await app.close();
  return response;
}

describe("request ids", () => {
  it("generates a uuid id when the client sends none", async () => {
    const response = await inject({ url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(UUID_PATTERN);
  });

  it("forwards a valid client-provided id unchanged", async () => {
    const response = await inject({
      url: "/health",
      headers: { "x-request-id": "client-trace-42" },
    });
    expect(response.headers["x-request-id"]).toBe("client-trace-42");
  });

  it("forwards an id of exactly the maximum length", async () => {
    const maxId = "a".repeat(64);
    const response = await inject({
      url: "/health",
      headers: { "x-request-id": maxId },
    });
    expect(response.headers["x-request-id"]).toBe(maxId);
  });

  it("replaces an oversized client id with a generated one", async () => {
    const tooLong = "a".repeat(65);
    const response = await inject({
      url: "/health",
      headers: { "x-request-id": tooLong },
    });
    expect(response.headers["x-request-id"]).not.toBe(tooLong);
    expect(response.headers["x-request-id"]).toMatch(UUID_PATTERN);
  });

  it("replaces an id containing unsafe characters", async () => {
    for (const unsafe of ["has spaces", "semi;colon", "quote\"mark", "$dollar$"]) {
      const response = await inject({
        url: "/health",
        headers: { "x-request-id": unsafe },
      });
      expect(response.headers["x-request-id"]).not.toBe(unsafe);
      expect(response.headers["x-request-id"]).toMatch(UUID_PATTERN);
    }
  });

  it("includes the request id in error responses", async () => {
    const response = await inject({
      url: "/streams/not-a-number",
      headers: { "x-request-id": "trace-error-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["x-request-id"]).toBe("trace-error-1");
    expect(response.json()).toEqual({
      error: "invalid stream id",
      requestId: "trace-error-1",
    });
  });

  it("attaches a generated id to errors when the client sent none", async () => {
    streamsRepo.getStream.mockResolvedValue(null);
    const response = await inject({ url: "/streams/999" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toBe("stream not found");
    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(response.headers["x-request-id"]).toBe(body.requestId);
  });

  it("attaches a request id to unmatched routes", async () => {
    const response = await inject({ url: "/nope" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.requestId).toMatch(UUID_PATTERN);
    expect(response.headers["x-request-id"]).toBe(body.requestId);
  });
});
