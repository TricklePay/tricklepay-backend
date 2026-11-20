import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { QueryTimeoutError } from "../src/db.js";

describe("Database 503 error handling", () => {
  it("returns 503 with Retry-After header for database connection errors", async () => {
    const app = await buildServer({});

    // Register a route that throws a database connection error
    app.get("/db-error", async () => {
      const error = new Error("Can't reach database server at `localhost:5432` P1001");
      throw error;
    });

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/db-error",
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");

    const body = JSON.parse(response.body);
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error).toBe("internal server error");
    expect(body.requestId).toBeDefined();

    await app.close();
  });

  it("returns 503 for QueryTimeoutError", async () => {
    const app = await buildServer({});

    app.get("/timeout-error", async () => {
      throw new QueryTimeoutError(5000);
    });

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/timeout-error",
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");

    await app.close();
  });

  it("returns 503 for Prisma connection refused errors", async () => {
    const app = await buildServer({});

    app.get("/connection-refused", async () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      throw error;
    });

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/connection-refused",
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");

    await app.close();
  });

  it("returns 500 for non-database errors", async () => {
    const app = await buildServer({});

    app.get("/app-error", async () => {
      throw new Error("Application logic error");
    });

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/app-error",
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["retry-after"]).toBeUndefined();

    await app.close();
  });
});
