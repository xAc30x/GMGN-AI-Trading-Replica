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

1. `GMGN_LIVE=1` required for `/api/sol/*` and legacy quote routes; this does not enable broadcast
2. `GMGN_SOL_BROADCAST=1` is a separate, default-off opt-in required to forward Solana `sendTransaction`
3. `X-GMGN-Token` required (from `GMGN_LOCAL_TOKEN` in `server/.env`)
4. Spend cap: `GMGN_MAX_NATIVE_AMOUNT` (default **0.05 SOL**)
5. Aggregate tracked exposure cap: `GMGN_MAX_PORTFOLIO_SOL` (default **0.1 SOL**) and `GMGN_MAX_OPEN_POSITIONS` (default **5**)
6. Slippage ceiling: `GMGN_MAX_SLIPPAGE_BPS` (default **300** = 3%)
7. Demo/placeholder mints denylisted; buy field starts empty; re-type CA
8. `/api/swap` and `/api/close` (gmgn-cli) return **410**
9. SOL path: `/api/sol/quote` + `/api/sol/swap-tx` return unsigned tx only
10. SL/TP text is **not** placed on-chain
11. Screening / PnL / wallet eval in the UI are still **mock** — do not treat them as risk checks

## Run

```bash
cd /home/gptanonymous/gmgn-ai-trader-replica
npm install
export GMGN_LIVE=1
# GMGN_SOL_BROADCAST stays unset; PAPER quotes/simulations do not need broadcast permission.
export GMGN_MAX_NATIVE_AMOUNT=0.05
npm run dev:all
```

Open http://127.0.0.1:5173/

1. Paste `GMGN_LOCAL_TOKEN` from `server/.env` into **Credentials**
2. Connect **Phantom** or **Solflare**
3. Keep SOL broadcast disabled while testing PAPER. SOL LIVE also requires the separate
  `GMGN_SOL_BROADCAST=1` server opt-in; do not set it until live execution is separately authorized.
4. For PAPER, enter a real mint and simulate it. Do not set `GMGN_SOL_BROADCAST` or enter SOL LIVE during this setup.

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
  The journal saves the signature before broadcast; unresolved signatures stay reserved
  and are checked again when that wallet reconnects. Inspect unknown signatures before retrying.
- Web Locks serialize wallet actions across tabs. A persisted trade ID and signed-payload hash
  make RPC retries idempotent; a reused ID with different bytes is rejected.
- Live records are stored in this browser and separated by wallet + chain + mint.
  Exposure uses tracked SOL cost, not current market value or exact token accounting.
  Close still explicitly sells the connected wallet's entire mint balance.
  Switching wallets cannot close another wallet's tracked record. PAPER/SHADOW cannot erase live records.
- Buys check tracked exposure and open-mint limits in the UI, again under the wallet lock,
  and at the server swap-build route. These are local-app guardrails, not chain-authoritative limits.
- LIVE/PAPER hide mock metrics. Wallet analysis and the copy calculator are labeled illustrative.

Tests use mocked providers and loopback-only HTTP fixtures. The end-to-end test signs a fixture
transaction with an ephemeral key and sends it only to the controlled local RPC; it never reaches a chain.
Importing the Express app does not start a server or generate/remove credentials.

Remaining boundaries: Jupiter and the selected RPC are trusted providers; transaction instructions
are not independently decoded as a full swap policy. Wallet approval remains mandatory.
Browser-held positions are not reconciled to token quantities or live market value, and browser
storage is not shared across devices. The server ledger records broadcast idempotency, not a complete
portfolio/accounting ledger. Strategy validation and automated exits are not implemented. Close
safety gates and the close-size bound remain in force.

### Private production deployment

Build with `npm ci --ignore-scripts` and `npm run build`, then run
`NODE_ENV=production GMGN_LIVE=0 npm run server`. The backend serves the built
frontend and API together at http://127.0.0.1:8787. It binds only to loopback.
Keep LIVE disabled until separately authorized and validated. Production serving
does not expose the source tree; unknown API routes remain 404.
