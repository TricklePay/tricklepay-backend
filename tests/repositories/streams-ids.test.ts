import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../../src/db.js";
import { countStreams, listStreams } from "../../src/repositories/streams.js";

describe("streams repository ids filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("combines ids, cursor and other filters in the database query", async () => {
    const findMany = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    await listStreams({ ids: [1n, 3n, 5n], cursor: 5n, cancelled: false });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { streamId: { in: [1n, 3n, 5n], lt: 5n }, cancelled: false },
      skip: 0,
    }));
  });

  it("uses the same ids predicate for the total count", async () => {
    const count = vi.spyOn(prisma.stream, "count").mockResolvedValueOnce(2);
    expect(await countStreams({ ids: [1n, 3n], cancelled: true })).toBe(2);
    expect(count).toHaveBeenCalledWith({
      where: { streamId: { in: [1n, 3n] }, cancelled: true },
    });
  });

  it("omits valid uint64 ids beyond PostgreSQL's storage range", async () => {
    const findMany = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    await listStreams({ ids: [1n, 18446744073709551615n] });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { streamId: { in: [1n] } },
    }));
  });

  it("combines ids and cursor with lifecycle status for lists and totals", async () => {
    const findMany = vi.spyOn(prisma.stream, "findMany").mockResolvedValueOnce([]);
    const count = vi.spyOn(prisma.stream, "count").mockResolvedValueOnce(0);
    const filter = { ids: [1n, 3n], cursor: 5n, status: "streaming" as const };
    await listStreams(filter, 100n);
    await countStreams(filter, 100n);
    const where = {
      streamId: { in: [1n, 3n], lt: 5n },
      cancelled: false,
      startTime: { lte: 100n },
      endTime: { gt: 100n },
    };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(count).toHaveBeenCalledWith({ where });
  });
});

