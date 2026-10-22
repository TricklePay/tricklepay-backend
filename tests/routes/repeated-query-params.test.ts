import Fastify from "fastify";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the behaviour of a repeated query parameter (?sender=A&sender=B) end
// to end, through the same custom querystringParser the real server installs
// in src/server.ts (`parseQueryString` — last-write-wins via
// URLSearchParams#forEach). A plain `Fastify()` instance, as other route
// tests in this suite use, falls back to fast-querystring's default, which
// returns an array for a repeated key instead — that would not exercise what
// production actually does, so this file wires the real parser in.

const streamsRepo = vi.hoisted(() => ({
  listStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/streams.js")>();
  return {
    ...actual,
    ...streamsRepo,
  };
});

const { parseQueryString } = await import("../../src/query-string-parser.js");
const { streamRoutes } = await import("../../src/routes/streams.js");

const SENDER_A = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SENDER_B = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

async function listRequest(url: string) {
  const app = Fastify({ querystringParser: parseQueryString });
  await app.register(streamRoutes);
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.resetAllMocks();
  streamsRepo.listStreams.mockResolvedValue({ streams: [] });
});

describe("GET /streams with a repeated query parameter", () => {
  it("keeps only the last value for a repeated filter parameter (sender)", async () => {
    const response = await listRequest(`/streams?sender=${SENDER_A}&sender=${SENDER_B}`);

    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ sender: SENDER_B }),
    );
    expect(streamsRepo.listStreams).not.toHaveBeenCalledWith(
      expect.objectContaining({ sender: SENDER_A }),
    );
  });

  it("keeps only the last value for a repeated pagination parameter (limit)", async () => {
    const response = await listRequest("/streams?limit=10&limit=20");

    expect(response.statusCode).toBe(200);
    expect(streamsRepo.listStreams).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
    expect(response.json()).toMatchObject({ limit: 20 });
  });
});
