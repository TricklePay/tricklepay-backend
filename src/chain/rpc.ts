import { rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";

// Creates the Soroban RPC client pointed at the configured endpoint. Plain
// HTTP is only allowed for local endpoints; remote endpoints must use HTTPS.
export function createRpcServer(config: Config): rpc.Server {
  return new rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });
}

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
    limit: options.limit ?? 100,
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
