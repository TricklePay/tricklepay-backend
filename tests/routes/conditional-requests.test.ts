import Fastify from "fastify";

import { beforeEach, describe, expect, it, vi } from "vitest";

// If-None-Match handling on every route that sets an ETag: lists of
// validators, the * wildcard, and weak/strong forms of the same value (#678).

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/streams.js")>();
  return { ...actual, ...streamsRepo };
});

const { streamRoutes } = await import("../../src/routes/streams.js");

function makeStream() {
  return {
    streamId: 42n,
    sender: "GA1sender",
    recipient: "GB2recipient",
    token: "CA3token",
    totalAmount: { toString: () => "1000000" },
    withdrawn: { toString: () => "0" },
    startTime: 1700000000n,
    endTime: 1700003600n,
    cliffTime: 1700000000n,
    cancelled: false,
    createdLedger: 100,
    updatedLedger: 200,
    lastEventId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

async function request(url: string, ifNoneMatch?: string) {
  const app = Fastify();
  await app.register(streamRoutes);
  const response = await app.inject({
    method: "GET",
    url,
    headers: ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch },
  });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
  streamsRepo.getStream.mockResolvedValue(makeStream());
  streamsRepo.listStreams.mockResolvedValue({ streams: [makeStream()] });
});

const routes = [
  { name: "GET /streams", url: "/streams" },
  { name: "GET /streams/:id", url: "/streams/42" },
  { name: "GET /streams/:id?at=", url: "/streams/42?at=1700001800" },
  { name: "GET /streams/:id/schedule", url: "/streams/42/schedule?points=10" },
];

describe.each(routes)("If-None-Match on $name", ({ url }) => {
  async function currentEtag(): Promise<string> {
    const response = await request(url);
    expect(response.statusCode).toBe(200);
    return response.headers["etag"] as string;
  }

  it("returns 304 for * ", async () => {
    const response = await request(url, "*");
    expect(response.statusCode).toBe(304);
    expect(response.body).toBe("");
  });

  it("returns 304 when the current tag appears in a list of validators", async () => {
    const etag = await currentEtag();
    const response = await request(url, `W/"stale-1", ${etag}, W/"stale-2"`);
    expect(response.statusCode).toBe(304);
    expect(response.body).toBe("");
  });

  it("returns 304 for the other (weak or strong) form of the current tag", async () => {
    const etag = await currentEtag();
    const other = etag.startsWith("W/") ? etag.slice(2) : `W/${etag}`;
    const response = await request(url, other);
    expect(response.statusCode).toBe(304);
  });

  it("returns 200 when no validator in the list matches", async () => {
    const response = await request(url, 'W/"stale-1", "stale-2"');
    expect(response.statusCode).toBe(200);
    expect(response.headers["etag"]).toBeDefined();
  });

  it("returns 200 for an unquoted tag that would otherwise match", async () => {
    const etag = await currentEtag();
    const bare = etag.replace(/^W\//, "").replace(/"/g, "");
    const response = await request(url, bare);
    expect(response.statusCode).toBe(200);
  });
});
