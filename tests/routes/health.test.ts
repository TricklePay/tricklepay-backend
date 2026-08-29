import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

// /health must report the running service version so deployment tooling can
// distinguish old and new binaries during rolling releases (#76). The value
// comes from the package manifest and requires no database or RPC access.

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", () => streamsRepo);

const { buildServer } = await import("../../src/server.js");
const { serviceVersion } = await import("../../src/version.js");

describe("health version field (#76)", () => {
  it("includes a stable version field sourced from the package manifest", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      version: pkg.version,
    });
  });

  it("exposes the same value through the shared version module", () => {
    expect(serviceVersion).toBeTypeOf("string");
    expect(serviceVersion.length).toBeGreaterThan(0);
    expect(serviceVersion).not.toBe("unknown");
  });

  it("stays independent of external dependencies when streams lookups fail", async () => {
    streamsRepo.getStream.mockRejectedValue(new Error("database down"));

    const app = await buildServer();
    await app.register((await import("../../src/routes/streams.js")).streamRoutes);
    // Break a database-backed route first; health must still answer.
    await app.inject({ method: "GET", url: "/streams/1" });

    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
    expect(response.json().version).toBeTypeOf("string");
  });
});
