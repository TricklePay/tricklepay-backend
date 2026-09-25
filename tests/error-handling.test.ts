import { describe, expect, it } from "vitest";

import {
  buildServer,
  errorCodeForStatus,
  redactErrorMessage,
} from "../src/server.js";

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
  it("redacts credentials and collapses multi-line errors in responses (#215)", async () => {
    const app = await buildServer();
    const error = new Error([
      "invalid connection postgres://tricklepay:s3cret@db.internal:5432/tricklepay",
      "    at TCP.connect (node:net:16:7)",
    ].join("\n")) as Error & { statusCode: number };
    error.statusCode = 400;
    app.get("/test-error", async () => {
      throw error;
    });

    const response = await app.inject({ method: "GET", url: "/test-error" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid connection [redacted]");
    expect(response.json().error).not.toContain("s3cret");
    expect(response.json().error).not.toContain("at TCP.connect");
    await app.close();
  });

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

  it("never leaks a stack trace or file path to the client", async () => {
    const app = await buildServer();
    
    app.get("/test-stack-leak", async () => {
      // Some libraries like Prisma embed stack traces and file paths in the error message itself.
      const err = new Error("Validation failed\n  at functionName (/home/user/project/src/file.ts:10:5)");
      (err as any).statusCode = 400;
      throw err;
    });

    const response = await app.inject({ method: "GET", url: "/test-stack-leak" });
    await app.close();

    const responseError = response.json().error as string;

    // Assert it produces a single-line message
    expect(responseError).not.toContain("\n");
    // Assert no file path appears in the response
    expect(responseError).not.toContain("/home/user/project");
    expect(responseError).not.toContain(".ts");
  });
});
