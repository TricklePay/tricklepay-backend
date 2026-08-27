import { describe, expect, it } from "vitest";

import {
  orderByFromFilter,
  type StreamFilter,
} from "../../src/repositories/streams.js";

describe("orderByFromFilter", () => {
  it("orders by streamId descending when no filters are set", () => {
    const filter: StreamFilter = {};
    expect(orderByFromFilter(filter)).toEqual([{ streamId: "desc" }]);
  });

  it("orders by cancelled-only filter by streamId descending", () => {
    const filter: StreamFilter = { cancelled: true };
    expect(orderByFromFilter(filter)).toEqual([{ streamId: "desc" }]);
  });

  it("orders by sender ascending then streamId descending when sender is filtered", () => {
    const filter: StreamFilter = { sender: "GADDR" };
    expect(orderByFromFilter(filter)).toEqual([
      { sender: "asc" },
      { streamId: "desc" },
    ]);
  });

  it("orders by recipient ascending then streamId descending when recipient is filtered", () => {
    const filter: StreamFilter = { recipient: "GADDR" };
    expect(orderByFromFilter(filter)).toEqual([
      { recipient: "asc" },
      { streamId: "desc" },
    ]);
  });

  it("orders by token ascending then streamId descending when token is filtered", () => {
    const filter: StreamFilter = { token: "CADDR" };
    expect(orderByFromFilter(filter)).toEqual([
      { token: "asc" },
      { streamId: "desc" },
    ]);
  });

  it("prioritizes sender over recipient when both are filtered", () => {
    const filter: StreamFilter = { sender: "GA", recipient: "GB" };
    expect(orderByFromFilter(filter)).toEqual([
      { sender: "asc" },
      { streamId: "desc" },
    ]);
  });

  it("prioritizes sender over token when both are filtered", () => {
    const filter: StreamFilter = { sender: "GA", token: "CA" };
    expect(orderByFromFilter(filter)).toEqual([
      { sender: "asc" },
      { streamId: "desc" },
    ]);
  });

  it("prioritizes recipient over token when both are filtered", () => {
    const filter: StreamFilter = { recipient: "GB", token: "CA" };
    expect(orderByFromFilter(filter)).toEqual([
      { recipient: "asc" },
      { streamId: "desc" },
    ]);
  });

  it("combines cancelled filter with sender-based ordering", () => {
    const filter: StreamFilter = { sender: "GA", cancelled: false };
    expect(orderByFromFilter(filter)).toEqual([
      { sender: "asc" },
      { streamId: "desc" },
    ]);
  });

  it("always terminates with streamId as the deterministic tie-breaker", () => {
    const combinations: StreamFilter[] = [
      {},
      { cancelled: true },
      { sender: "GA" },
      { recipient: "GB" },
      { token: "CA" },
      { sender: "GA", recipient: "GB", token: "CA" },
      { sender: "GA", cancelled: true, limit: 10, offset: 0 },
    ];
    for (const filter of combinations) {
      const orderBy = orderByFromFilter(filter);
      expect(orderBy.length).toBeGreaterThanOrEqual(1);
      const last = orderBy[orderBy.length - 1];
      expect(last).toEqual({ streamId: "desc" });
    }
  });
});
