import { AsyncLocalStorage } from "node:async_hooks";

/** AsyncLocalStorage storing the active request's AbortSignal (#675). */
export const requestSignalStorage = new AsyncLocalStorage<AbortSignal>();
