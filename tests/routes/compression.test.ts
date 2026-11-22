import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The API serves large, highly repetitive list responses. @fastify/compress is
// registered with a byte threshold, so responses below it stay uncompressed
// (the encoding overhead would outweigh the saving) while larger ones are
// compressed for clients that advertise support. These tests pin down both
// halves of that behaviour, plus the client-negotiation rule.

const { buildServer } = await import("../../src/server.js");

/** Registers a route that returns a body of exactly `bytes` JSON characters. */
function largeBodyOfBytes(bytes: number): string {
  const overhead = Buffer.byteLength(JSON.stringify({ data: "" }), "utf8");
  return JSON.stringify({ data: "x".repeat(bytes - overhead) });
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Builds a server with one route returning the given body. */
async function serverWithBody(body: string, thresholdBytes?: number): Promise<FastifyInstance> {
  app = await buildServer(
    thresholdBytes === undefined ? undefined : { compressionThresholdBytes: thresholdBytes },
  );
  app.get("/payload", async (_request, reply) => {
    reply.header("content-type", "application/json");
    return body;
  });
  await app.ready();
  return app;
}

describe("response compression", () => {
  it("compresses a response above the threshold when the client accepts it", async () => {
    const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

    const response = await server.inject({
      method: "GET",
      url: "/payload",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
  });

  it("compresses with brotli when the client prefers it", async () => {
    const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

    const response = await server.inject({
      method: "GET",
      url: "/payload",
      headers: { "accept-encoding": "br" },
    });

    expect(response.headers["content-encoding"]).toBe("br");
  });

  it("leaves a response below the threshold uncompressed", async () => {
    const server = await serverWithBody(largeBodyOfBytes(64), 1024);

    const response = await server.inject({
      method: "GET",
      url: "/payload",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
  });

  it("does not compress for a client that does not accept an encoding", async () => {
    const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

    const response = await server.inject({
      method: "GET",
      url: "/payload",
      headers: { "accept-encoding": "identity" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
  });

  it("honours a configured threshold rather than a fixed default", async () => {
    const body = largeBodyOfBytes(2048);

    const strict = await serverWithBody(body, 512);
    const strictResponse = await strict.inject({
      method: "GET",
      url: "/payload",
      headers: { "accept-encoding": "gzip" },
    });
    expect(strictResponse.headers["content-encoding"]).toBe("gzip");

    const permissive = await serverWithBody(body, 8192);
    const permissiveResponse = await permissive.inject({
      method: "GET",
      url: "/payload",
      headers: { "accept-encoding": "gzip" },
    });
    expect(permissiveResponse.headers["content-encoding"]).toBeUndefined();
  });
});
