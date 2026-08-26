import { describe, expect, it } from "vitest";
import {
  errorCodeForStatus,
  redactErrorMessage,
} from "../../src/server.js";

// Structured error codes (#73): every failure carries a stable machine-
// readable code derived from the status, without changing messages or status
// behavior. Redaction (#74): outgoing error messages never contain
// credential-bearing URLs or stack traces; the raw text stays server-side.

describe("errorCodeForStatus (#73)", () => {
  it("maps validation failures to VALIDATION_ERROR", () => {
    expect(errorCodeForStatus(400)).toBe("VALIDATION_ERROR");
  });

  it("maps missing resources to NOT_FOUND", () => {
    expect(errorCodeForStatus(404)).toBe("NOT_FOUND");
  });

  it("maps unexpected failures to INTERNAL_SERVER_ERROR", () => {
    expect(errorCodeForStatus(500)).toBe("INTERNAL_SERVER_ERROR");
    expect(errorCodeForStatus(503)).toBe("INTERNAL_SERVER_ERROR");
  });

  it("falls back to REQUEST_ERROR for other client errors", () => {
    expect(errorCodeForStatus(429)).toBe("REQUEST_ERROR");
  });
});

describe("redactErrorMessage (#74)", () => {
  it("removes credentials embedded in connection strings", () => {
    const message =
      'Invalid prisma.$queryRaw invocation: postgres://tricklepay:s3cret@db.internal:5432/tricklepay failed';
    const redacted = redactErrorMessage(message);
    expect(redacted).not.toContain("s3cret");
    expect(redacted).not.toContain("db.internal");
    expect(redacted).toContain("[redacted]");
  });

  it("keeps only the first line of multi-line errors (stack traces)", () => {
    const message = [
      "connection refused",
      "    at TCP.connect (node:net:16:7)",
      "    at Socket.connect (node:net)",
    ].join("\n");
    const redacted = redactErrorMessage(message);
    expect(redacted).toBe("connection refused");
    expect(redacted).not.toContain("at TCP.connect");
  });

  it("leaves plain validation messages untouched", () => {
    expect(redactErrorMessage("invalid stream id")).toBe("invalid stream id");
  });
});
