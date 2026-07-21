# AmpliFi Protocol Frontend

React + Tailwind frontend connected directly to the AmpliFi Soroban contract through Stellar RPC and Stellar Wallets Kit.

## Features

- Multi-wallet connection through Stellar Wallets Kit
- Live protocol configuration and paused status
- Supported-market dashboard
- Pool liquidity, debt, utilization and long/short borrow APR
- Open long and short positions
- Partial or full position close (`None` is sent for 100%)
- Deposit liquidity and withdraw LP shares
- USDC wallet balance and transfer
- Testnet Friendbot link
- Transaction simulation, wallet signing, submission and status polling

## Run

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Or use npm:

```bash
npm install
npm run dev
```

## Required configuration

Update `.env` with the deployed protocol, USDC SAC and supported market SAC addresses. `VITE_MARKETS` is required because the current contract does not expose a market registry/list method.

## Important contract limitations

1. The contract exposes `get_position(id)` but not `get_position_count()` or `get_positions_by_owner()`. The UI scans IDs up to `VITE_POSITION_SCAN_LIMIT` and filters by owner.
2. LP-share balances are not exposed by the current contract. Withdrawal therefore accepts LP shares in base units.
3. There is no generic protocol collateral deposit account. Collateral is transferred during `open_long` / `open_short`.
4. This UI assumes the no-stop-loss/no-take-profit ABI discussed in the contract update.

For a production deployment, add contract methods for market enumeration, owner-position indexing and LP-share balance reads.
