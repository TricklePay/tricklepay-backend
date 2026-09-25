import { describe, expect, it, vi } from "vitest";

import { createShutdown } from "../src/shutdown.js";

// Shutdown must close the database connection, and must finish, so a container
// can exit cleanly instead of hanging on an open pool (#220).

describe("createShutdown", () => {
  it("disconnects the database during shutdown and completes", async () => {
    const calls: string[] = [];
    const poller = {
      stop: vi.fn(() => {
        calls.push("poller.stop");
      }),
    };
    const app = {
      close: vi.fn(async () => {
        calls.push("app.close");
      }),
    };
    const disconnect = vi.fn(async () => {
      calls.push("disconnect");
    });
    const exit = vi.fn();
    const logger = { info: vi.fn() };

    const shutdown = createShutdown({ poller, app, disconnect, logger, exit });

    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // Teardown order: stop polling, drain HTTP, then close the database.
    expect(calls).toEqual(["poller.stop", "app.close", "disconnect"]);
  });

  it("does not disconnect the database until the server has closed", async () => {
    let serverClosed = false;
    const app = {
      close: vi.fn(async () => {
        serverClosed = true;
      }),
    };
    const disconnect = vi.fn(async () => {
      expect(serverClosed).toBe(true);
    });

    const shutdown = createShutdown({
      poller: { stop: vi.fn() },
      app,
      disconnect,
      logger: { info: vi.fn() },
      exit: vi.fn(),
    });

    await shutdown("SIGINT");

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("logs the signal being handled", async () => {
    const logger = { info: vi.fn() };

    const shutdown = createShutdown({
      poller: { stop: vi.fn() },
      app: { close: vi.fn(async () => {}) },
      disconnect: vi.fn(async () => {}),
      logger,
      exit: vi.fn(),
    });

    await shutdown("SIGTERM");

    expect(logger.info).toHaveBeenCalledWith({ signal: "SIGTERM" }, "shutting down");
  });
});
