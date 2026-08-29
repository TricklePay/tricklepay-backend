import { rpc } from "@stellar/stellar-sdk";

import { isLocalUrl } from "../config.js";

import type { Config } from "../config.js";

// Creates the Soroban RPC client pointed at the configured endpoint. Plain
// HTTP is only allowed for local endpoints (localhost / 127.x.x.x); the config
// layer already rejects remote http:// URLs at startup, so this is a final
// safeguard in case the server is constructed outside of `loadConfig`.
export function createRpcServer(config: Config): rpc.Server {
  return new rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://") && isLocalUrl(config.rpcUrl),
  });
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
  const request: rpc.Server.GetEventsRequest = {
    filters: [{ type: "contract", contractIds: [contractId] }],
    limit: options.limit ?? EVENT_PAGE_LIMIT,
  };

  // The RPC accepts either a cursor or a start ledger, not both.
  if (options.cursor !== undefined) {
    request.cursor = options.cursor;
  } else if (options.startLedger !== undefined) {
    request.startLedger = options.startLedger;
  }

  const response = await server.getEvents(request);
  return {
    events: response.events,
    latestLedger: response.latestLedger,
    cursor: response.cursor,
  };
}
