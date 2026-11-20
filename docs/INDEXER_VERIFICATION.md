# Indexer Chain Verification Guide

To ensure high reliability and trust in the TricklePay backend, operators and developers can independently verify that the local indexed database state matches the authoritative state on the Stellar/Soroban blockchain.

---

## 1. Overview & Verification Strategy

The TricklePay indexer ingests contract events and ledger entries. While real-time synchronization is standard, periodic verification allows operators to confirm there is zero state drift caused by missed events, ledger reorgs, or network partitions.

Verification is performed by comparing:
1. **On-Chain State**: Directly querying the Soroban smart contract storage or RPC endpoints.
2. **Indexed State**: Querying the local backend PostgreSQL database or REST API endpoints.

---

## 2. Step-by-Step Verification Procedure

### Step 2.1: Query On-Chain State (Stellar/Soroban CLI)
Using the Stellar CLI or Soroban RPC, inspect a specific stream or contract entry directly from the network:

```bash
stellar contract read \
  --id <CONTRACT_ID> \
  --network testnet \
  --key <STREAM_LEDGER_KEY>