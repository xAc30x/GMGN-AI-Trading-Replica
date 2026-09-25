# AI Trader Demo Replica

Unaffiliated Vite + React UI inspired by the GMGN AI Trader demo, with a local Express backend.

## Trading modes

| Mode | Behavior |
|------|----------|
| SHADOW | Simulate only |
| **SOL LIVE** | Jupiter builds an **unsigned** swap; **your wallet** signs (Phantom / Solflare) |
| Other chains LIVE | Quote + copy intent only — no in-app submit |

This process **never** stores or uses `GMGN_PRIVATE_KEY`.

## Hard rails

1. `GMGN_LIVE=1` required for `/api/sol/*` and legacy quote routes
2. `X-GMGN-Token` required (from `GMGN_LOCAL_TOKEN` in `server/.env`)
3. Spend cap: `GMGN_MAX_NATIVE_AMOUNT` (default **0.05 SOL**)
4. Slippage ceiling: `GMGN_MAX_SLIPPAGE_BPS` (default **300** = 3%)
5. Demo/placeholder mints denylisted; buy field starts empty; re-type CA
6. `/api/swap` and `/api/close` (gmgn-cli) return **410**
7. SOL path: `/api/sol/quote` + `/api/sol/swap-tx` return unsigned tx only
8. SL/TP text is **not** placed on-chain
9. Screening / PnL / wallet eval in the UI are still **mock** — do not treat them as risk checks

## Run

```bash
cd /home/gptanonymous/gmgn-ai-trader-replica
npm install
export GMGN_LIVE=1
export GMGN_MAX_NATIVE_AMOUNT=0.05
npm run dev:all
```

Open http://127.0.0.1:5173/

1. Paste `GMGN_LOCAL_TOKEN` from `server/.env` into **Credentials**
2. Connect **Phantom** or **Solflare**
3. Chain **SOL** → MODE **LIVE**
4. Buy → paste real mint twice → set slippage → check the box → **Sign SOL swap in wallet**

Optional: set `VITE_SOLANA_RPC_URL` to a dedicated RPC (Helius / QuickNode). Public mainnet RPC is fine for smoke tests, flaky for production.

## Mint safety + rug scan (SOL)

Before a LIVE buy/close can sign, `/api/sol/mint-safety` runs:

1. **On-chain** — SPL mint, freeze authority (hard block unless allowlisted USDC/USDT), supply
2. **RugCheck** — rugged flag, normalised score (`GMGN_MAX_RUG_SCORE`, default 40), danger-level risks, liquidity floor (`GMGN_MIN_LIQUIDITY_USD`), top-holder concentration
3. **GoPlus** — non-transferable, closable, transfer hook, freezable
4. Jupiter price impact above `GMGN_MAX_PRICE_IMPACT_PCT` (default 5%) on quote/swap/close

If both RugCheck and GoPlus are unreachable, LIVE fails closed (except allowlisted stables).

## SOL endpoints

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/sol/quote` | Jupiter ExactIn quote (SOL → mint) |
| POST | `/api/sol/mint-safety` | On-chain freeze/mint/supply checks |
| POST | `/api/sol/watchlist-scan` | Batch mint-safety for up to 8 watchlist mints |
| POST | `/api/sol/swap-tx` | Unsigned buy (SOL→mint); mint safety + impact gate |
| POST | `/api/sol/close-tx` | Unsigned sell (mint→SOL); wallet signs |

## Still not “fully safe”

Wallet signing removes hot-key custody from this app. You can still lose money to bad mints, thin liquidity, MEV, RPC issues, or approving the wrong wallet prompt. Start with a throwaway wallet and a tiny cap. Real token safety screening is not built yet.

## Stack

- Vite + React 19 + TypeScript
- `@solana/wallet-adapter-*` + `@solana/web3.js`
- Jupiter lite-api (`lite-api.jup.ag/swap/v1`) via Express proxy

## Responsible setup

1. Set a dedicated RPC (not public mainnet) for both server mint-safety and the browser:
   ```bash
   export SOLANA_RPC_URL='https://your-helius-or-quicknode'
   export VITE_SOLANA_RPC_URL="$SOLANA_RPC_URL"
   ```
2. Keep `GMGN_MAX_NATIVE_AMOUNT` tiny (e.g. `0.01`) while learning.
3. Cycle mode **SHADOW → PAPER → LIVE**. Use PAPER until simulations look right.
4. In **PAPER/LIVE**, the table is a **live watchlist** (RugCheck/GoPlus per mint). SHADOW still uses mock rows.
5. Run money-path unit tests:
   ```bash
   npm test
   ```
