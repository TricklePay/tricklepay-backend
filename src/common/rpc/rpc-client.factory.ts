
import { Server } from '@stellar/stellar-sdk/rpc'; // Adjust based on your RPC SDK import

export interface RpcClientOptions {
  url?: string;
  timeout?: number;
}

/**
 * Constructs and returns the standard RPC client instance with centralized transport policy.
 */
export function createRpcClient(options?: RpcClientOptions): Server {
  const rpcUrl = options?.url || process.env.STELLAR_RPC_URL || 'https://horizon-testnet.stellar.org';
  
  return new Server(rpcUrl, {
    allowHttp: process.env.NODE_ENV === 'development',
    timeout: options?.timeout || 10000,
  });
}