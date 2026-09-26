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

If both providers are unavailable or return invalid data, LIVE fails closed (except existing allowlisted mints). With a nonzero liquidity floor, a valid RugCheck liquidity figure meeting that floor is required for nonallowlisted mints, including when GoPlus is available.

## SOL endpoints

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/sol/quote` | Jupiter ExactIn quote (SOL → mint) |
| POST | `/api/sol/mint-safety` | On-chain freeze/mint/supply checks |
| POST | `/api/sol/watchlist-scan` | Batch mint-safety for up to 8 watchlist mints |
| POST | `/api/sol/swap-tx` | Unsigned buy (SOL→mint); mint safety + impact gate |
| POST | `/api/sol/close-tx` | Unsigned sell (mint→SOL); wallet signs |

## Still not “fully safe”

Wallet signing removes hot-key custody from this app. You can still lose money to bad mints, thin liquidity, MEV, RPC issues, or approving the wrong wallet prompt. Start with a throwaway wallet and a tiny cap. Safety screening is implemented, but it is not a guarantee of token safety or profitable execution.

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


## Audit defect fixes

Requires Node 22.12+. Client regression tests use the project's TypeScript compiler.
Run verification with npm ci --ignore-scripts, npm test, npm run build, and npm run lint.

- Transaction builds obtain a fresh server-owned ExactIn quote. Caller quotes are ignored.
  Mints, exact input amount, slippage, minimum output and price impact are validated.
  Preview prices can change; review the final transaction in your wallet.
- Jupiter impact is a fraction (0.01 = 1%). Missing/invalid values block the route.
- Scanner payloads must match the exact mint and expected schema. Zero/unknown
  liquidity cannot satisfy an enabled liquidity floor. RugCheck holder percentages
  are percentage points, without guessing units.
- server/.env loads before provider limits/RPC constants. Invalid numeric limits fail.
  Put browser RPC configuration in Vite's environment; it is separate from server configuration.
- Confirmation checks the execution error and uses the submitted blockhash.
  Unknown confirmation errors include the signature: inspect it before retrying.
- Live records are stored in this browser and separated by wallet + chain + mint.
  They are tracked holdings, not reconciled accounting or exact purchase lots.
  Close still explicitly sells the connected wallet's entire mint balance.
  Switching wallets cannot close another wallet's tracked record. PAPER/SHADOW cannot erase live records.
- LIVE/PAPER hide mock metrics. Wallet analysis and the copy calculator are labeled illustrative.

Tests use mocked providers and local ephemeral HTTP listeners; they never sign or send trades.
Importing the Express app does not start a server or generate/remove credentials.

Remaining boundaries: Jupiter and the selected RPC are trusted providers; transaction instructions
are not independently decoded as a full swap policy. Wallet approval remains mandatory.
Local browser storage is not a durable shared execution ledger. In-tab signing is serialized,
but cross-tab idempotency, recovery/reconciliation, portfolio limits, strategy validation,
and automated exits remain separate work. Close safety gates and the close-size bound remain
in force; this patch does not bypass them to sell unsafe tokens.
