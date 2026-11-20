export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

export interface PaginationQuery {
  limit?: string;
  offset?: string;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export class PaginationValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";
  constructor(public readonly parameter: "limit" | "offset") {
    super(`invalid ${parameter}`);
    this.name = "PaginationValidationError";
  }
}

function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const val = Number(raw);
  if (!Number.isSafeInteger(val)) return null;
  return val;
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const val = parseNonNegativeInt(raw);
  if (val === null) throw new PaginationValidationError("limit");
  return Math.min(val, MAX_LIMIT);
}

export function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const val = parseNonNegativeInt(raw);
  if (val === null) throw new PaginationValidationError("offset");
  return val;
}

/** Parse the shared limit/offset query parameters used by paginated routes. */
export function parsePagination(query: PaginationQuery): Pagination {
  return {
    limit: parseLimit(query.limit),
    offset: parseOffset(query.offset),
  };
}
