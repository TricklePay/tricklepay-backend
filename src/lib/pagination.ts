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

/** Name the malformed field so callers can return a specific validation error. */
export class InvalidPaginationParameter extends Error {
  constructor(readonly parameter: "limit" | "offset") {
    super(`invalid ${parameter}`);
    this.name = "InvalidPaginationParameter";
  }
}

function decimalInteger(value: string, parameter: "limit" | "offset"): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new InvalidPaginationParameter(parameter);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new InvalidPaginationParameter(parameter);
  return n;
}

/** Parse the shared limit/offset query parameters used by paginated routes. */
export function parsePagination(query: PaginationQuery): Pagination {
  const rawLimit = query.limit === undefined ? DEFAULT_LIMIT : decimalInteger(query.limit, "limit");
  const rawOffset = query.offset === undefined ? 0 : decimalInteger(query.offset, "offset");
  if (rawLimit === 0) throw new InvalidPaginationParameter("limit");
  return { limit: Math.min(rawLimit, MAX_LIMIT), offset: rawOffset };
}
