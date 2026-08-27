// Shared JSON Schema definitions for every API response shape.
//
// Defining schemas here rather than inline in route files serves two purposes:
// 1. @fastify/swagger picks them up and emits them as reusable $components so
//    the generated OpenAPI spec stays tidy and client generators can produce
//    named types (StreamView, StreamListResponse, …) instead of anonymous ones.
// 2. Fastify uses the response schemas to serialise and validate outgoing JSON,
//    which is a small but free correctness win.
//
// All numeric token amounts are serialised as decimal strings because they are
// 128-bit integers that exceed the safe range of a JavaScript number, and
// therefore of IEEE 754 double-precision JSON numbers.

// ---------------------------------------------------------------------------
// $id constants — used both here and when referencing the schema from routes.
// ---------------------------------------------------------------------------
export const STREAM_VIEW_SCHEMA_ID = "StreamView";
export const STREAM_LIST_RESPONSE_SCHEMA_ID = "StreamListResponse";
export const STREAM_SUMMARY_RESPONSE_SCHEMA_ID = "StreamSummaryResponse";
export const INDEXER_STATUS_SCHEMA_ID = "IndexerStatus";
export const ERROR_SCHEMA_ID = "ApiError";

// ---------------------------------------------------------------------------
// StreamView — a single token stream as the API renders it.
// ---------------------------------------------------------------------------
export const streamViewSchema = {
  $id: STREAM_VIEW_SCHEMA_ID,
  type: "object",
  description:
    "A token stream as stored by the indexer. Amount fields are decimal strings " +
    "because the contract uses 128-bit integers that exceed JavaScript's safe integer range.",
  required: [
    "id",
    "sender",
    "recipient",
    "token",
    "totalAmount",
    "withdrawn",
    "vested",
    "withdrawable",
    "locked",
    "progress",
    "startTime",
    "endTime",
    "cliffTime",
    "cancelled",
    "status",
  ],
  properties: {
    id: {
      type: "string",
      description: "Unique stream identifier (uint64, decimal string).",
      examples: ["42"],
    },
    sender: {
      type: "string",
      description: "Stellar address of the stream creator.",
      examples: ["GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
    },
    recipient: {
      type: "string",
      description: "Stellar address of the stream recipient.",
      examples: ["GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"],
    },
    token: {
      type: "string",
      description: "Stellar address of the streamed token contract.",
      examples: ["CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7"],
    },
    totalAmount: {
      type: "string",
      description: "Total tokens locked in the stream (uint128, decimal string).",
      examples: ["100000000000000"],
    },
    withdrawn: {
      type: "string",
      description: "Total tokens already withdrawn by the recipient (uint128, decimal string).",
      examples: ["25000000000000"],
    },
    vested: {
      type: "string",
      description:
        "Tokens that have vested as of the time this response was generated (uint128, decimal string).",
      examples: ["50000000000000"],
    },
    withdrawable: {
      type: "string",
      description:
        "Tokens the recipient may withdraw right now: vested minus already withdrawn (uint128, decimal string).",
      examples: ["25000000000000"],
    },
    locked: {
      type: "string",
      description: "Tokens not yet vested (uint128, decimal string).",
      examples: ["50000000000000"],
    },
    progress: {
      type: "integer",
      description:
        "Vesting progress in basis points (0–10000). 10000 means fully vested.",
      minimum: 0,
      maximum: 10000,
      examples: [5000],
    },
    startTime: {
      type: "string",
      description: "Vesting start time (Unix seconds, decimal string).",
      examples: ["1735689600"],
    },
    endTime: {
      type: "string",
      description: "Vesting end time (Unix seconds, decimal string).",
      examples: ["1767225600"],
    },
    cliffTime: {
      type: "string",
      description:
        "Cliff time: nothing vests before this (Unix seconds, decimal string).",
      examples: ["1740000000"],
    },
    cancelled: {
      type: "boolean",
      description: "Whether the stream has been cancelled.",
    },
    status: {
      type: "string",
      enum: ["pending", "streaming", "completed", "cancelled"],
      description:
        "Derived lifecycle status: pending (not yet started), streaming (active), " +
        "completed (fully vested), cancelled.",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// StreamListResponse — paginated list of streams.
// ---------------------------------------------------------------------------
export const streamListResponseSchema = {
  $id: STREAM_LIST_RESPONSE_SCHEMA_ID,
  type: "object",
  description:
    "Paginated list of streams. The total is only computed and included when " +
    "the request opted in with includeTotal=true. Opaque cursor pagination is " +
    "stable under concurrent inserts and takes precedence over offset when both are provided.",
  required: ["streams", "limit", "offset"],
  properties: {
    streams: {
      type: "array",
      items: { $ref: STREAM_VIEW_SCHEMA_ID },
      description: "The streams on this page.",
    },
    total: {
      type: "integer",
      description:
        "Total number of streams matching the query filters. Present only when " +
        "the request passed includeTotal=true; omitted otherwise to avoid the count query.",
      examples: [123],
    },
    limit: {
      type: "integer",
      description: "Maximum number of streams returned on this page.",
      examples: [50],
    },
    offset: {
      type: "integer",
      description:
        "Zero-based index of the first stream on this page. Reflects the offset " +
        "from the request and is 0 on cursor-driven pages.",
      examples: [0],
    },
    nextCursor: {
      type: "string",
      description:
        "Opaque cursor for the next page. Omitted when there are no further pages. " +
        "Pass this as the cursor query parameter to fetch the next page with stable ordering.",
      examples: ["eyJzdHJlYW1JZCI6IjQyIn0"],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// StreamSummaryResponse — counts and amount totals per lifecycle status.
// ---------------------------------------------------------------------------
const streamStatusSummarySchema = (description: string) =>
  ({
    type: "object",
    description,
    required: ["count", "totalAmount", "withdrawn"],
    properties: {
      count: {
        type: "integer",
        description: "Number of streams currently in this status.",
        minimum: 0,
        examples: [12],
      },
      totalAmount: {
        type: "string",
        description:
          "Sum of totalAmount across the streams in this status (uint128, decimal string).",
        examples: ["1000000000000000"],
      },
      withdrawn: {
        type: "string",
        description:
          "Sum of withdrawn across the streams in this status (uint128, decimal string).",
        examples: ["25000000000000"],
      },
    },
  }) as const;

export const streamSummaryResponseSchema = {
  $id: STREAM_SUMMARY_RESPONSE_SCHEMA_ID,
  type: "object",
  description:
    "Counts and amount totals for all indexed streams grouped by lifecycle status. " +
    "Totals are aggregated by the database over the decimal columns, so they stay exact.",
  required: ["pending", "streaming", "completed", "cancelled"],
  properties: {
    pending: streamStatusSummarySchema(
      "Streams whose vesting has not started yet: current time is before startTime.",
    ),
    streaming: streamStatusSummarySchema(
      "Active streams: started, not cancelled, and not fully vested.",
    ),
    completed: streamStatusSummarySchema(
      "Fully vested streams: current time has reached endTime.",
    ),
    cancelled: streamStatusSummarySchema("Streams that have been cancelled."),
  },
} as const;

// ---------------------------------------------------------------------------
// IndexerStatus — indexer progress report.
// ---------------------------------------------------------------------------
export const indexerStatusSchema = {
  $id: INDEXER_STATUS_SCHEMA_ID,
  type: "object",
  description: "Indexer progress relative to the chain.",
  required: ["indexer", "chain", "lagLedgers"],
  properties: {
    indexer: {
      type: "object",
      required: ["initialized", "lastLedger", "cursor", "updatedAt"],
      properties: {
        initialized: {
          type: "boolean",
          description: "False until the indexer completes its first poll.",
        },
        lastLedger: {
          type: "integer",
          description: "Highest ledger whose events the indexer has applied.",
          examples: [56290013],
        },
        cursor: {
          type: ["string", "null"],
          description: "RPC paging cursor to resume from, or null before the first poll.",
        },
        updatedAt: {
          type: ["string", "null"],
          format: "date-time",
          description: "When the position was last written, or null before the first poll.",
        },
      },
    },
    chain: {
      type: "object",
      required: ["latestLedger"],
      properties: {
        latestLedger: {
          type: "integer",
          description: "Chain's latest ledger as of the last poll.",
          examples: [56999999],
        },
      },
    },
    lagLedgers: {
      type: ["integer", "null"],
      description:
        "Ledgers the indexer is behind the chain. Null before the first poll. Never negative.",
      examples: [709986],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// ApiError — error response envelope.
// ---------------------------------------------------------------------------
export const apiErrorSchema = {
  $id: ERROR_SCHEMA_ID,
  type: "object",
  description: "Error response.",
  required: ["code", "error", "requestId"],
  properties: {
    code: {
      type: "string",
      enum: [
        "VALIDATION_ERROR",
        "NOT_FOUND",
        "REQUEST_ERROR",
        "INTERNAL_SERVER_ERROR",
      ],
      description:
        "Stable machine-readable error category so clients can retry or " +
        "correct input without parsing the message.",
      examples: ["NOT_FOUND"],
    },
    error: {
      type: "string",
      description: "Human-readable error message.",
      examples: ["stream not found"],
    },
    requestId: {
      type: "string",
      description:
        "Request id echoed from the x-request-id response header, for matching " +
        "this error to its server log entry.",
      examples: ["req-1"],
    },
  },
} as const;
