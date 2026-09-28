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
11. SHADOW metrics and wallet evaluation are **mock**; PAPER/LIVE discovery and holdings use provider data

## Run

```bash
cd /home/gptanonymous/gmgn-ai-trader-release
npm install
# Keep both actual-service execution gates disabled.
unset GMGN_LIVE GMGN_SOL_BROADCAST
npm run dev:all
```

Open http://127.0.0.1:5173/

1. Paste `GMGN_LOCAL_TOKEN` from `server/.env` into **Credentials**
2. Connect **Phantom** or **Solflare**
3. Keep both execution gates unset. LIVE/PAPER service routes remain disabled in this setup.
   Automated tests use isolated loopback fixtures that never submit a real trade.

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

Requires Node 22.13+ for the built-in SQLite reservation ledger. Client regression tests use the project's TypeScript compiler.
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
- Before wallet approval, the browser independently decodes the unsigned v0 message,
  resolves every address lookup table, checks wallet authority and trade-mint accounts,
  accepts only the supported Jupiter Route exact-in instruction (up to five known
  route steps) and approved setup programs,
  matches exact amounts/slippage/minimum output, and bounds network/platform fees.
  Unexpected transfers and unsupported instructions fail closed.
- Buy limits are computed by the server from fresh SPL Token and Token-2022 balances,
  valued as the sum of fresh Jupiter ExactIn minimum-output SOL quotes. Pending buy
  amounts are reserved atomically in a durable server ledger before Jupiter builds.
  Request-supplied portfolio figures are ignored. Stale RPC slots, unavailable balances,
  invalid quotes, ledger errors, and uncertain signatures block or retain capacity.
- Close amount is bounded by the connected wallet's chain-reconciled mint balance.
  Browser-held position records are display/history only, never buy-limit authority.
- The reservation ledger is SQLite with durable `BEGIN IMMEDIATE` transactions and
  mode-600 database permissions. RPC/quote work runs outside the write transaction;
  the final limit check and reservation commit are atomic across processes sharing the
  same local database. Existing default JSON reservations migrate once and the source
  file is retained. Keep the database on persistent local storage: SQLite is not a
  distributed ledger and network filesystems or separate backend hosts are unsupported.
- LIVE/PAPER hide mock metrics. Wallet analysis and the copy calculator are labeled illustrative.

Server tests use mocked providers and loopback-only HTTP fixtures. Browser tests run the actual
React trading flow in Chromium with an isolated injected mock wallet and intercepted API/RPC
fixtures; they never connect to or submit transactions to a blockchain. Run them with
`npm run test:browser`. Importing the Express app does not start a server or generate/remove credentials.

This is not production-ready. Jupiter and the selected RPC remain trusted for route construction,
balances, fees, and quote data; the client supports only its explicitly decoded Jupiter Route
instruction variant and rejects other variants. The file-backed ledger is suitable only for a
single shared backend filesystem, not horizontally scaled or multi-host deployment. Wallet approval
remains mandatory. Strategy validation, audited deployment controls, distributed accounting, and
automated exits are not implemented. No trade should be submitted against real services until those
boundaries are separately reviewed and authorized.

### Private production deployment

Build with `npm ci --ignore-scripts` and `npm run build`, then run
`NODE_ENV=production GMGN_LIVE=0 npm run server`. The backend serves the built
frontend and API together at http://127.0.0.1:8787. It binds only to loopback.
Keep LIVE disabled until separately authorized and validated. Production serving
does not expose the source tree; unknown API routes remain 404.


## Consolidated discovery and holdings features

`gmgn-ai-trader-release` is the integration base. Discovery and holdings monitoring
were ported from local `main` at `a88d3d5` while retaining the release transaction
validator, default-off broadcast gate, durable reservations, and signature reconciliation.

- In SOL PAPER/LIVE, discovery lists DexScreener top-boosted tokens or latest profiles,
  screens them with the existing mint checks, and supports adding them to the watchlist.
  These feeds are not investment rankings or a guarantee that a token just launched.
  Provider reference: https://docs.dexscreener.com/api/reference
- Tracked holdings read wallet balances every 15 seconds and request valuations every
  second while the page is visible. Jupiter quote requests share a process-local
  `GMGN_PNL_QUOTES_PER_MIN` budget (default 40); cached quotes are labeled and expire
  after 60 seconds. Market-price fallback is labeled as an estimate.
- The percentage compares the current whole-wallet mint balance with recorded buy
  cost. It is not realized PnL or tax accounting: external transfers and partial sales
  can change that comparison. Quotes exclude network fees and account rent.
- Two successful zero-balance checks hide a holding without deleting its history or
  journal. Monitoring continues so a returning balance can reappear. Invalid or failed
  balance reads do not count as zero. Wallet changes clear the displayed valuation scope.
- `/api/sol/discover`, `/api/sol/prices`, and `/api/sol/position-values` are read-only,
  authenticated, and require the existing `GMGN_LIVE` service gate. They cannot submit
  transactions. No execution flags need changing to run the isolated test suite.

The original replica and audit worktrees remain available; their execution-path
variants were not merged over the release safeguards.
