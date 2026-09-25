// ---------------------------------------------------------------------------
// Graceful shutdown.
//
// Extracted from `index.ts` so the sequence can be unit-tested without booting
// the process. The order matters:
//
// 1. Stop the poller first so it doesn't start new poll ticks or initiate
//    fresh database writes. `stop()` is synchronous — it sets a flag and the
//    current page/transaction finishes, but no new tick begins.
//
// 2. Close the HTTP server next. Fastify stops accepting new connections and
//    waits for all in-flight request handlers to complete. Those handlers may
//    still query the database, so we keep the connection pool open.
//
// 3. Disconnect the database last, only after the HTTP server has fully
//    drained, so in-flight requests never hit a closed connection.
// ---------------------------------------------------------------------------

/** Minimal logger surface used here; satisfied by the shared pino logger. */
export interface ShutdownLogger {
  info: (...args: unknown[]) => void;
}

export interface ShutdownDeps {
  /** Stops the indexer poller from starting new ticks. */
  poller: { stop: () => void };
  /** Closes the HTTP server, awaiting in-flight requests. */
  app: { close: () => Promise<void> };
  /** Closes the shared database connection pool. */
  disconnect: () => Promise<void>;
  logger: ShutdownLogger;
  /** Exit callback; defaults to `process.exit`. Injectable for tests. */
  exit?: (code: number) => void;
}

/**
 * Builds the shutdown handler for a signal. Runs the ordered teardown above,
 * then exits with code 0 (or invokes the injected `exit`).
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number): void => process.exit(code));

  return async (signal: string): Promise<void> => {
    deps.logger.info({ signal }, "shutting down");
    deps.poller.stop();
    await deps.app.close();
    await deps.disconnect();
    exit(0);
  };
}
