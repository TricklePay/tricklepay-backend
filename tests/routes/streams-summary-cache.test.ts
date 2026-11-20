import Fastify from "fastify";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /streams/summary serves a cached payload and advertises the time left in
// the cache window rather than the full TTL (#471). That subtraction is only
// visible through the clock, so these tests drive one: `Date` is faked while
// timers are left alone, and the system time is stepped forward to age the
// cached entry.

const streamsRepo = vi.hoisted(() => ({
  getStream: vi.fn(),
  listStreams: vi.fn(),
  countStreams: vi.fn(),
  aggregateStreams: vi.fn(),
}));

vi.mock("../../src/repositories/streams.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/streams.js")>();
  return {
    ...actual,
    ...streamsRepo,
  };
});

const { DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS } = await import("../../src/config.js");
const { streamRoutes } = await import("../../src/routes/streams.js");

const START = Date.parse("2026-01-01T00:00:00.000Z");

// A window well above a second, so the countdown is observable at the
// granularity `max-age` is expressed in.
const TTL_MS = 30_000;
const TTL_SECONDS = TTL_MS / 1000;

// One app per test, so successive requests share a single cache instance.
async function buildApp(summaryCacheTtlMs: number) {
  const app = Fastify();
  await app.register(streamRoutes, { summaryCacheTtlMs });
  return app;
}

async function getSummary(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({ method: "GET", url: "/streams/summary" });
}

function maxAgeOf(response: Awaited<ReturnType<typeof getSummary>>): number {
  const header = response.headers["cache-control"];
  expect(typeof header).toBe("string");
  const match = /max-age=(-?\d+)/.exec(header as string);
  expect(match, `no max-age in "${header}"`).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

beforeEach(() => {
  vi.resetAllMocks();
  streamsRepo.aggregateStreams.mockResolvedValue({ count: 0, totalAmount: "0", withdrawn: "0" });
  // Only the clock is faked: Fastify's own timers keep running normally.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /streams/summary cache window", () => {
  it("counts max-age down as the cached entry ages", async () => {
    const app = await buildApp(TTL_MS);
    try {
      const fresh = await getSummary(app);
      expect(fresh.statusCode).toBe(200);
      expect(maxAgeOf(fresh)).toBe(TTL_SECONDS);

      // Each step ages the same cached entry further into the window, so the
      // advertised lifetime must shrink by the time elapsed.
      const observed = [maxAgeOf(fresh)];
      for (const elapsedMs of [1_000, 10_000, 25_000, TTL_MS - 1]) {
        vi.setSystemTime(START + elapsedMs);
        const response = await getSummary(app);

        expect(response.statusCode).toBe(200);
        expect(maxAgeOf(response)).toBe(Math.floor((TTL_MS - elapsedMs) / 1000));
        observed.push(maxAgeOf(response));
      }

      // Never larger than the previous reading, and the window is gone by the
      // end of it rather than being re-advertised in full.
      expect(observed).toEqual([...observed].sort((a, b) => b - a));
      expect(observed.at(-1)).toBe(0);

      // All of those were cache hits: the aggregates ran once, for the four
      // lifecycle statuses of the first request.
      expect(streamsRepo.aggregateStreams).toHaveBeenCalledTimes(4);
    } finally {
      await app.close();
    }
  });

  it("resets max-age to the full window on a fresh computation", async () => {
    const app = await buildApp(TTL_MS);
    try {
      expect(maxAgeOf(await getSummary(app))).toBe(TTL_SECONDS);

      vi.setSystemTime(START + TTL_MS - 1);
      expect(maxAgeOf(await getSummary(app))).toBe(0);

      // The window has now elapsed, so this request recomputes and the
      // advertised lifetime starts over at the top.
      vi.setSystemTime(START + TTL_MS);
      expect(maxAgeOf(await getSummary(app))).toBe(TTL_SECONDS);
      expect(streamsRepo.aggregateStreams).toHaveBeenCalledTimes(8);

      // And it counts down again from there, against the new entry rather than
      // the first one.
      vi.setSystemTime(START + TTL_MS + 5_000);
      expect(maxAgeOf(await getSummary(app))).toBe(TTL_SECONDS - 5);
      expect(streamsRepo.aggregateStreams).toHaveBeenCalledTimes(8);
    } finally {
      await app.close();
    }
  });

  it("advertises the configured window by default", async () => {
    const app = await buildApp(DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS);
    try {
      expect(maxAgeOf(await getSummary(app))).toBe(
        Math.floor(DEFAULT_STREAM_SUMMARY_CACHE_TTL_MS / 1000),
      );
    } finally {
      await app.close();
    }
  });

  it("never advertises a negative max-age", async () => {
    const app = await buildApp(TTL_MS);
    try {
      // Sweep the window, including both ends and well past it: an entry past
      // its window is recomputed rather than served with a stale remainder.
      for (const elapsedMs of [0, 1, 15_000, TTL_MS - 1, TTL_MS, TTL_MS * 10]) {
        vi.setSystemTime(START + elapsedMs);
        const response = await getSummary(app);

        expect(response.statusCode).toBe(200);
        expect(maxAgeOf(response)).toBeGreaterThanOrEqual(0);
        expect(maxAgeOf(response)).toBeLessThanOrEqual(TTL_SECONDS);
      }

      // A clock that steps backwards leaves a negative age, which must not be
      // turned into a lifetime longer than the window either.
      vi.setSystemTime(START - 60_000);
      const afterStepBack = await getSummary(app);
      expect(maxAgeOf(afterStepBack)).toBeGreaterThanOrEqual(0);
      expect(maxAgeOf(afterStepBack)).toBeLessThanOrEqual(TTL_SECONDS);
    } finally {
      await app.close();
    }
  });
});
