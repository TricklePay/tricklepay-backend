import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../../src/db.js";

import {
  getIndexerPosition,
  saveIndexerPosition,
} from "../../src/repositories/indexer-state.js";

describe("indexer state repository round trip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads back a saved position unchanged", async () => {
    const position = {
      lastLedger: 100,
      chainLedger: 200,
      cursor: "AAABBB",
    };

    const upsert = vi.spyOn(prisma.indexerState, "upsert").mockResolvedValueOnce({
      id: "stream",
      lastLedger: position.lastLedger,
      chainLedger: position.chainLedger,
      cursor: position.cursor,
      updatedAt: new Date(),
    } as never);

    await saveIndexerPosition(position);

    expect(upsert).toHaveBeenCalledWith({
      where: { id: "stream" },
      create: { id: "stream", ...position },
      update: position,
    });

    const findUnique = vi.spyOn(prisma.indexerState, "findUnique").mockResolvedValueOnce({
      id: "stream",
      lastLedger: position.lastLedger,
      chainLedger: position.chainLedger,
      cursor: position.cursor,
      updatedAt: new Date(),
    } as never);

    const result = await getIndexerPosition();

    expect(findUnique).toHaveBeenCalledWith({ where: { id: "stream" } });
    expect(result).toEqual({
      lastLedger: position.lastLedger,
      chainLedger: position.chainLedger,
      cursor: position.cursor,
      updatedAt: expect.any(Date),
    });
    expect(result!.lastLedger).toBe(100);
    expect(result!.chainLedger).toBe(200);
    expect(result!.cursor).toBe("AAABBB");
  });

  it("returns null when no position has been saved yet", async () => {
    const findUnique = vi.spyOn(prisma.indexerState, "findUnique").mockResolvedValueOnce(null);

    const result = await getIndexerPosition();

    expect(findUnique).toHaveBeenCalledWith({ where: { id: "stream" } });
    expect(result).toBeNull();
  });

  it("round-trips a position with a null cursor", async () => {
    const position = {
      lastLedger: 50,
      chainLedger: 75,
      cursor: null,
    };

    vi.spyOn(prisma.indexerState, "upsert").mockResolvedValueOnce({
      id: "stream",
      ...position,
      updatedAt: new Date(),
    } as never);

    await saveIndexerPosition(position);

    vi.spyOn(prisma.indexerState, "findUnique").mockResolvedValueOnce({
      id: "stream",
      ...position,
      updatedAt: new Date(),
    } as never);

    const result = await getIndexerPosition();

    expect(result).not.toBeNull();
    expect(result!.lastLedger).toBe(50);
    expect(result!.chainLedger).toBe(75);
    expect(result!.cursor).toBeNull();
  });

  it("preserves large ledger values", async () => {
    const position = {
      lastLedger: 4294967295,
      chainLedger: 4294967296,
      cursor: "CURSOR_VALUE",
    };

    vi.spyOn(prisma.indexerState, "upsert").mockResolvedValueOnce({
      id: "stream",
      ...position,
      updatedAt: new Date(),
    } as never);

    await saveIndexerPosition(position);

    vi.spyOn(prisma.indexerState, "findUnique").mockResolvedValueOnce({
      id: "stream",
      ...position,
      updatedAt: new Date(),
    } as never);

    const result = await getIndexerPosition();

    expect(result!.lastLedger).toBe(4294967295);
    expect(result!.chainLedger).toBe(4294967296);
  });
});
