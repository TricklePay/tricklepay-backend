import { rpc } from "@stellar/stellar-sdk";

import { isLocalUrl } from "../config.js";

import type { Config } from "../config.js";

// Creates the Soroban RPC client pointed at the configured endpoint. Plain
// HTTP is only allowed for loopback endpoints (localhost / 127.x.x.x / [::1]);
// the config layer already rejects remote http:// URLs at startup, so this is
// a final safeguard in case the server is constructed outside of `loadConfig`.
export function createRpcServer(config: Config): rpc.Server {
  return new rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://") && isLocalUrl(config.rpcUrl),
  });
}

// Fail before serving requests when the configured RPC endpoint cannot be
// reached, rather than letting the indexer retry an invalid endpoint forever.
export async function verifyRpcEndpoint(server: rpc.Server, rpcUrl: string): Promise<void> {
  try {
    await server.getLatestLedger();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to reach configured Soroban RPC endpoint "${rpcUrl}": ${detail}`,
      { cause: err },
    );
  }
}

// How many events to ask the RPC for at a time. The poller compares a page's
// size against this to tell a full page — there is more behind it — from a
// short one, so the request and that comparison must share the number.
export const EVENT_PAGE_LIMIT = 100;

export interface EventPage {
  events: rpc.Api.EventResponse[];
  latestLedger: number;
  cursor: string;
}

// Fetches a page of events emitted by the given contract. Pass `cursor` to
// continue from a previous page, or `startLedger` to begin at a specific
// ledger. The response carries a cursor to resume from on the next call.
export async function getContractEvents(
  server: rpc.Server,
  contractId: string,
  options: { startLedger?: number; cursor?: string; limit?: number },
): Promise<EventPage> {
  const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [contractId] }];
  const limit = options.limit ?? EVENT_PAGE_LIMIT;

  // The RPC accepts either a cursor or a start ledger, not both. The SDK types
  // this as a union that requires one of them; the cast keeps the old
  // behaviour of sending neither when the caller has neither yet.
  const request = (
    options.cursor !== undefined
      ? { filters, cursor: options.cursor, limit }
      : options.startLedger !== undefined
        ? { filters, startLedger: options.startLedger, limit }
        : { filters, limit }
  ) as rpc.Server.GetEventsRequest;

  const response = await server.getEvents(request);
  return {
    events: response.events,
    latestLedger: response.latestLedger,
    cursor: response.cursor,
  };
}
