import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// Authoritative stream state read directly from the contract. The fields mirror
// the contract's `Stream` struct.
export interface OnChainStream {
  sender: string;
  recipient: string;
  token: string;
  totalAmount: bigint;
  withdrawn: bigint;
  startTime: bigint;
  endTime: bigint;
  cliffTime: bigint;
  cancelled: boolean;
}

// Reads a stream's full state by simulating a `get_stream` call. Simulation is
// read only and costs nothing, so a throwaway source account is used. Returns
// null when the stream does not exist (the call returns StreamNotFound).
export async function fetchStream(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  streamId: bigint,
): Promise<OnChainStream | null> {
  const contract = new Contract(contractId);
  const source = new Account(Keypair.random().publicKey(), "0");

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("get_stream", nativeToScVal(streamId, { type: "u64" })))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    return null;
  }

  const s = scValToNative(sim.result.retval) as Record<string, bigint | string | boolean>;
  return {
    sender: s.sender as string,
    recipient: s.recipient as string,
    token: s.token as string,
    totalAmount: s.total_amount as bigint,
    withdrawn: s.withdrawn as bigint,
    startTime: s.start_time as bigint,
    endTime: s.end_time as bigint,
    cliffTime: s.cliff_time as bigint,
    cancelled: s.cancelled as boolean,
  };
}
