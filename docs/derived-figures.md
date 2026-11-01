# Derived Figures and Real-Time Vesting Computation

This document details how the TricklePay backend computes stream balances, why derived values are evaluated on-demand at request time, and how this architecture guarantees consistency with the Soroban smart contract.

## Architecture Overview

When a client queries stream endpoints (`GET /streams`, `GET /streams/:id`, `GET /streams/summary`), the returned response contains two distinct categories of fields:

1. **Stored Fields (State from Chain Events)**
2. **Derived Fields (Dynamically Computed on Request)**

```
┌──────────────────────────────────────────────┐
│             Postgres Database                │
│ (Updated only when on-chain events occur)    │
│  - streamId, sender, recipient, token        │
│  - totalAmount, withdrawn                    │
│  - startTime, endTime, cliffTime, cancelled  │
└──────────────────────┬───────────────────────┘
                       │ Read on request
                       ▼
┌──────────────────────────────────────────────┐
│               API View Layer                 │
│         (Evaluated at request time)          │
│  - now = Date.now() / 1000                   │
│  - vestedAmount(total, start, end, cliff, now)│
│  - withdrawable = vested - withdrawn         │
│  - locked = total - vested                   │
│  - progress = (vested * 10000) / total       │
│  - status = pending | streaming | completed  │
└──────────────────────────────────────────────┘
```

## What is Stored in the Database

The database stores only immutable stream schedule parameters and explicit state transitions emitted by smart contract events:

- `streamId` — Unique numeric identifier of the stream.
- `sender` — Stellar address of the stream creator / funder.
- `recipient` — Stellar address of the payout beneficiary.
- `token` — Stellar address of the SAC token contract.
- `totalAmount` — Total token amount allocated to the stream.
- `withdrawn` — Cumulative amount claimed and withdrawn by the recipient.
- `startTime` — Unix timestamp (seconds) when linear vesting begins.
- `endTime` — Unix timestamp (seconds) when 100% of the stream is vested.
- `cliffTime` — Unix timestamp (seconds) before which 0% is vested.
- `cancelled` — Boolean indicating if the stream was terminated early.

## Why Derived Figures are Computed at Request Time

Fields such as `vested`, `withdrawable`, `locked`, `progress`, and `status` are continuously changing functions of time.

Computing these figures dynamically on every incoming request offers critical advantages:

1. **Zero Database Write Overhead**:
   If `vested` and `withdrawable` were stored as database columns, the database would have to update every active stream row every single second. With thousands of streams, this would cause extreme database write amplification and lock contention.

2. **Always-Accurate Wall-Clock Precision**:
   By evaluating the formula against `Date.now()` at the exact millisecond a client requests data, the API reports the true current state of the stream without any polling lag or indexing delays.

3. **Minimal CPU Cost**:
   Linear vesting calculation (`src/lib/vesting.ts`) involves basic integer arithmetic on BigInts:
   $$\text{vested} = \frac{\text{totalAmount} \times (\text{now} - \text{startTime})}{\text{endTime} - \text{startTime}}$$
   Executing this calculation in-memory in Node.js takes fractions of a microsecond per stream.

## Consistency with the On-Chain Smart Contract

The vesting algorithm in `src/lib/vesting.ts` exactly mirrors the linear vesting logic implemented in the Soroban smart contract (`tricklepay-contracts`).

### Mathematical Parity

- **Before `startTime`**: `vested = 0`, `withdrawable = 0`, `status = "pending"`.
- **Before `cliffTime`**: `vested = 0`, `withdrawable = 0`, `status = "streaming"`.
- **Between `startTime`/`cliffTime` and `endTime`**: Vests linearly by second.
- **At or after `endTime`**: `vested = totalAmount`, `withdrawable = totalAmount - withdrawn`, `status = "completed"`.
- **Cancelled Streams**: Frozen at the point of cancellation; `totalAmount` is set to the amount vested at cancellation while `withdrawn` remains the amount withdrawn so far, leaving the recipient's unwithdrawn balance claimable and `status = "cancelled"`.

Because the API uses the identical formula and the current clock, **the API's returned `withdrawable` figure matches what the on-chain contract would calculate if a withdrawal transaction were submitted at that exact moment**, all without requiring a slow, expensive Soroban RPC simulation.
