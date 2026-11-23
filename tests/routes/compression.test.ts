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
    // Set a stable ETag so we can test conditional requests across encodings
    reply.header("etag", '"test-payload-v1"');
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

  describe("Vary header for cache correctness", () => {
    it("includes Vary: Accept-Encoding on compressible responses", async () => {
      const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

      const response = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "gzip" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.vary).toMatch(/accept-encoding/i);
    });

    it("includes Vary: Accept-Encoding even when compression is not applied", async () => {
      const server = await serverWithBody(largeBodyOfBytes(64), 1024);

      const response = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "gzip" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.vary).toMatch(/accept-encoding/i);
    });

    it("includes Vary: Accept-Encoding for identity encoding", async () => {
      const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

      const response = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "identity" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.vary).toMatch(/accept-encoding/i);
      expect(response.headers["content-encoding"]).toBeUndefined();
    });
  });

  describe("ETag stability across encodings", () => {
    it("returns the same ETag for gzip, brotli, and identity encodings", async () => {
      const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

      const gzipResponse = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "gzip" },
      });

      const brotliResponse = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "br" },
      });

      const identityResponse = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "identity" },
      });

      expect(gzipResponse.headers.etag).toBeDefined();
      expect(brotliResponse.headers.etag).toBe(gzipResponse.headers.etag);
      expect(identityResponse.headers.etag).toBe(gzipResponse.headers.etag);
    });

    it("conditional request with uncompressed ETag returns 304 for compressed response", async () => {
      const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

      // First, get the uncompressed version and its ETag
      const uncompressedResponse = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "identity" },
      });

      expect(uncompressedResponse.statusCode).toBe(200);
      const etag = uncompressedResponse.headers.etag;
      expect(etag).toBeDefined();

      // Now request compressed with If-None-Match using the uncompressed ETag
      const conditionalResponse = await server.inject({
        method: "GET",
        url: "/payload",
        headers: {
          "accept-encoding": "gzip",
          "if-none-match": etag as string,
        },
      });

      expect(conditionalResponse.statusCode).toBe(304);
      expect(conditionalResponse.body).toBe("");
    });

    it("conditional request with compressed ETag returns 304 for uncompressed response", async () => {
      const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

      // First, get the compressed version and its ETag
      const compressedResponse = await server.inject({
        method: "GET",
        url: "/payload",
        headers: { "accept-encoding": "gzip" },
      });

      expect(compressedResponse.statusCode).toBe(200);
      expect(compressedResponse.headers["content-encoding"]).toBe("gzip");
      const etag = compressedResponse.headers.etag;
      expect(etag).toBeDefined();

      // Now request uncompressed with If-None-Match using the compressed ETag
      const conditionalResponse = await server.inject({
        method: "GET",
        url: "/payload",
        headers: {
          "accept-encoding": "identity",
          "if-none-match": etag as string,
        },
      });

      expect(conditionalResponse.statusCode).toBe(304);
      expect(conditionalResponse.body).toBe("");
    });

    it("conditional request returns 200 when ETag does not match", async () => {
      const server = await serverWithBody(largeBodyOfBytes(4096), 1024);

      const response = await server.inject({
        method: "GET",
        url: "/payload",
        headers: {
          "accept-encoding": "gzip",
          "if-none-match": '"stale-etag"',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(response.body).not.toBe("");
    });
  });
});
