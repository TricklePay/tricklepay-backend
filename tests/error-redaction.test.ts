import { describe, expect, it } from "vitest";

import {
  errorCodeForStatus,
  redactErrorMessage,
  type ApiErrorCode,
} from "../src/error-redaction.js";

// Direct unit tests for the error-redaction module (#239).

describe("redactErrorMessage", () => {
  it("removes credentials embedded in connection strings", () => {
    const message =
      "Invalid prisma.$queryRaw invocation: postgres://tricklepay:s3cret@db.internal:5432/tricklepay failed";
    const redacted = redactErrorMessage(message);
    expect(redacted).not.toContain("s3cret");
    expect(redacted).not.toContain("db.internal");
    expect(redacted).toContain("[redacted]");
  });

  it("keeps only the first line of multi-line errors", () => {
    const message = [
      "connection refused",
      "    at TCP.connect (node:net:16:7)",
      "    at Socket.connect (node:net)",
    ].join("\n");
    expect(redactErrorMessage(message)).toBe("connection refused");
  });

  it("leaves plain validation messages untouched", () => {
    expect(redactErrorMessage("invalid stream id")).toBe("invalid stream id");
  });

  it("handles multiple credential URLs on one line", () => {
    const message =
      "failed: postgres://a:b@host1/db and postgres://c:d@host2/db2";
    const redacted = redactErrorMessage(message);
    expect(redacted).not.toContain(":b@");
    expect(redacted).not.toContain(":d@");
  });

  it("trims leading/trailing whitespace from the first line", () => {
    expect(redactErrorMessage("  oops  \nsecond line")).toBe("oops");
  });
});

describe("errorCodeForStatus", () => {
  it("maps 400 to VALIDATION_ERROR", () => {
    expect(errorCodeForStatus(400)).toBe<ApiErrorCode>("VALIDATION_ERROR");
  });

  it("maps 404 to NOT_FOUND", () => {
    expect(errorCodeForStatus(404)).toBe<ApiErrorCode>("NOT_FOUND");
  });

  it("maps 500 and above to INTERNAL_SERVER_ERROR", () => {
    expect(errorCodeForStatus(500)).toBe<ApiErrorCode>("INTERNAL_SERVER_ERROR");
    expect(errorCodeForStatus(503)).toBe<ApiErrorCode>("INTERNAL_SERVER_ERROR");
  });

  it("maps other 4xx codes to REQUEST_ERROR", () => {
    expect(errorCodeForStatus(429)).toBe<ApiErrorCode>("REQUEST_ERROR");
    expect(errorCodeForStatus(401)).toBe<ApiErrorCode>("REQUEST_ERROR");
  });
});
