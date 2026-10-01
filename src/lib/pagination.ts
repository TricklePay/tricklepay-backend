const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export interface PaginationQuery {
  limit?: string;
  offset?: string;
}

export interface Pagination {
  limit: number;
  offset: number;
}

/** Parse the shared limit/offset query parameters used by paginated routes. */
export function parsePagination(query: PaginationQuery): Pagination {
  const rawLimit = query.limit ? Number(query.limit) : DEFAULT_LIMIT;
  const rawOffset = query.offset ? Number(query.offset) : 0;

  return {
    limit: !Number.isFinite(rawLimit) || rawLimit <= 0
      ? DEFAULT_LIMIT
      : Math.min(Math.floor(rawLimit), MAX_LIMIT),
    offset: !Number.isFinite(rawOffset) || rawOffset < 0 ? 0 : Math.floor(rawOffset),
  };
}
