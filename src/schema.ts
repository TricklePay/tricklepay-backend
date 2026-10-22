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
export const STREAM_SCHEDULE_RESPONSE_SCHEMA_ID = "StreamScheduleResponse";
export const STREAM_EVENT_SCHEMA_ID = "StreamEvent";
export const STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID = "StreamEventHistoryResponse";
export const INDEXER_STATUS_SCHEMA_ID = "IndexerStatus";
export const ERROR_SCHEMA_ID = "ApiError";
export const API_INDEX_SCHEMA_ID = "ApiIndex";
export const TOKEN_SUMMARY_SCHEMA_ID = "TokenSummary";
export const TOKEN_LIST_RESPONSE_SCHEMA_ID = "TokenListResponse";
export const ACCOUNT_STREAM_SUMMARY_SCHEMA_ID = "AccountStreamSummary";
export const ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID = "AccountSummaryResponse";

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
    "createdLedger",
    "updatedLedger",
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
    createdLedger: {
      type: "integer",
      description: "Ledger sequence number in which the stream was created on-chain.",
      examples: [100],
    },
    updatedLedger: {
      type: "integer",
      description:
        "Ledger sequence number of the most recent on-chain event applied to this stream.",
      examples: [200],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// StreamScheduleResponse — vesting curve points for charting.
// ---------------------------------------------------------------------------
export const streamScheduleResponseSchema = {
  $id: STREAM_SCHEDULE_RESPONSE_SCHEMA_ID,
  type: "object",
  description: "Vesting curve schedule points for charting a stream.",
  required: ["points"],
  properties: {
    points: {
      type: "array",
      items: {
        type: "object",
        required: ["time", "amount", "vested"],
        properties: {
          time: {
            type: "string",
            description: "Point timestamp in Unix seconds (decimal string).",
            examples: ["1735689600"],
          },
          amount: {
            type: "string",
            description: "Vested token amount as of this timestamp (uint128, decimal string).",
            examples: ["50000000000000"],
          },
          vested: {
            type: "string",
            description: "Vested token amount as of this timestamp (uint128, decimal string).",
            examples: ["50000000000000"],
          },
        },
      },
      description: "Evenly spaced schedule points between start and end, with cliff step included.",
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

export const streamEventSchema = {
  $id: STREAM_EVENT_SCHEMA_ID,
  type: "object",
  description:
    "A single stream event retained for auditability. Amount fields are decimal strings to avoid precision loss.",
  required: ["eventId", "kind", "streamId", "ledger", "txHash"],
  properties: {
    eventId: {
      type: "string",
      description: "RPC event id in TOID-index form, used as the ordering key.",
      examples: ["0000000000000000000000000000000000000001-0000000000000001"],
    },
    kind: {
      type: "string",
      enum: ["created", "withdrawn", "cancelled"],
      description: "Event kind emitted by the stream contract.",
    },
    streamId: {
      type: "string",
      description: "Stream id associated with the event (uint64, decimal string).",
      examples: ["42"],
    },
    ledger: {
      type: "integer",
      description: "Ledger sequence containing the event.",
      examples: [123456],
    },
    txHash: {
      type: "string",
      description: "Transaction hash that emitted the event.",
      examples: ["66f7505577a417f4c1187fb8a8eeb6f3737f848d5f0b3b20c5a6c57ab7d659d1"],
    },
    sender: {
      type: ["string", "null"],
      description: "Sender address for created/cancelled events, if present.",
    },
    recipient: {
      type: ["string", "null"],
      description: "Recipient address for created/withdrawn/cancelled events, if present.",
    },
    token: {
      type: ["string", "null"],
      description: "Token contract address for created events, if present.",
    },
    totalAmount: {
      type: ["string", "null"],
      description: "Total amount for created events, as a decimal string.",
    },
    amount: {
      type: ["string", "null"],
      description: "Withdrawn amount for withdrawal events, as a decimal string.",
    },
    recipientAmount: {
      type: ["string", "null"],
      description: "Recipient payout for cancellation events, as a decimal string.",
    },
    senderRefund: {
      type: ["string", "null"],
      description: "Sender refund for cancellation events, as a decimal string.",
    },
    startTime: {
      type: ["string", "null"],
      description: "Stream start time, in Unix seconds, for created events.",
    },
    endTime: {
      type: ["string", "null"],
      description: "Stream end time, in Unix seconds, for created events.",
    },
    cliffTime: {
      type: ["string", "null"],
      description: "Vesting cliff time, in Unix seconds, for created events.",
    },
    closedAt: {
      type: ["string", "null"],
      description: "Ledger close time, in Unix seconds, for the event.",
    },
  },
} as const;

export const streamEventHistoryResponseSchema = {
  $id: STREAM_EVENT_HISTORY_RESPONSE_SCHEMA_ID,
  type: "array",
  description: "Indexed stream event history in ascending TOID order.",
  items: { $ref: STREAM_EVENT_SCHEMA_ID },
} as const;

// ---------------------------------------------------------------------------
// TokenSummary and TokenListResponse — distinct tokens with counts and totals.
// ---------------------------------------------------------------------------
export const tokenSummarySchema = {
  $id: TOKEN_SUMMARY_SCHEMA_ID,
  type: "object",
  description: "A distinct token with its stream count and total escrowed amount.",
  required: ["token", "count", "total"],
  properties: {
    token: {
      type: "string",
      description: "Stellar token contract address.",
      examples: ["CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7"],
    },
    count: {
      type: "integer",
      description: "Number of streams using this token.",
      minimum: 0,
      examples: [12],
    },
    total: {
      type: "string",
      description:
        "Total amount escrowed across streams for this token (uint128, decimal string).",
      examples: ["1000000000000000"],
    },
  },
} as const;

export const tokenListResponseSchema = {
  $id: TOKEN_LIST_RESPONSE_SCHEMA_ID,
  type: "array",
  description: "List of distinct tokens with their stream counts and total escrowed amounts.",
  items: { $ref: TOKEN_SUMMARY_SCHEMA_ID },
} as const;

// ---------------------------------------------------------------------------
// AccountStreamSummary and AccountSummaryResponse — incoming and outgoing totals.
// ---------------------------------------------------------------------------
export const accountStreamSummarySchema = {
  $id: ACCOUNT_STREAM_SUMMARY_SCHEMA_ID,
  type: "object",
  description: "Summary of stream counts and token totals for an address.",
  required: [
    "count",
    "totalAmount",
    "total",
    "withdrawn",
    "vested",
    "withdrawable",
  ],
  properties: {
    count: {
      type: "integer",
      description: "Number of streams.",
      minimum: 0,
      examples: [3],
    },
    totalAmount: {
      type: "string",
      description: "Total allocated tokens (uint128, decimal string).",
      examples: ["100000000000000"],
    },
    total: {
      type: "string",
      description: "Total allocated tokens (alias for totalAmount, uint128, decimal string).",
      examples: ["100000000000000"],
    },
    withdrawn: {
      type: "string",
      description: "Total tokens already withdrawn (uint128, decimal string).",
      examples: ["25000000000000"],
    },
    vested: {
      type: "string",
      description: "Total tokens vested as of now (uint128, decimal string).",
      examples: ["50000000000000"],
    },
    withdrawable: {
      type: "string",
      description: "Total tokens currently withdrawable (uint128, decimal string).",
      examples: ["25000000000000"],
    },
  },
} as const;

export const accountSummaryResponseSchema = {
  $id: ACCOUNT_SUMMARY_RESPONSE_SCHEMA_ID,
  type: "object",
  description: "Account summary containing incoming and outgoing stream totals.",
  required: ["incoming", "outgoing"],
  properties: {
    incoming: { $ref: ACCOUNT_STREAM_SUMMARY_SCHEMA_ID },
    outgoing: { $ref: ACCOUNT_STREAM_SUMMARY_SCHEMA_ID },
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
      required: ["initialized", "startLedger", "lastLedger", "cursor", "updatedAt", "consecutiveFailures", "nextPollAt"],
      properties: {
        initialized: {
          type: "boolean",
          description: "False until the indexer completes its first poll.",
        },
        startLedger: {
          type: "integer",
          description:
            "Configured ledger to begin indexing from for a fresh database. 0 starts at the chain's latest ledger; a saved cursor takes precedence.",
          examples: [0, 56290013],
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
        consecutiveFailures: {
          type: "integer",
          description:
            "Number of consecutive poll iterations that have failed since the last success. " +
            "Resets to 0 after a successful tick. Use alongside nextPollAt to understand backoff state.",
          minimum: 0,
          examples: [0, 3],
        },
        nextPollAt: {
          type: ["string", "null"],
          format: "date-time",
          description:
            "ISO 8601 timestamp of the next scheduled poll attempt. " +
            "Non-null only while the poller is in backoff after one or more failures; null during normal polling.",
          examples: [null, "2026-10-19T12:05:30.000Z"],
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
    failedEventCount: {
      type: "integer",
      description:
        "Number of unresolved failed events the indexer has not yet retried. " +
        "Zero means nothing is stuck. A rising number signals degraded indexing.",
      examples: [0, 12],
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
        "RATE_LIMITED",
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

// ---------------------------------------------------------------------------
// ApiIndex — the self-describing index served at the root.
// ---------------------------------------------------------------------------
export const apiIndexSchema = {
  $id: API_INDEX_SCHEMA_ID,
  type: "object",
  description: "Self-describing index of the API.",
  required: ["name", "description", "network", "contractId", "endpoints"],
  properties: {
    name: { type: "string", examples: ["tricklepay-backend"] },
    description: { type: "string" },
    network: {
      type: "string",
      description: "Stellar network this instance indexes.",
      examples: ["testnet"],
    },
    contractId: {
      type: "string",
      description:
        "Soroban contract id of the stream contract this instance indexes, so a " +
        "client can confirm it is pointed at the deployment it expects.",
    },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        required: ["method", "path", "description"],
        properties: {
          method: { type: "string" },
          path: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
} as const;
