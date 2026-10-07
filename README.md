# AI Trader Demo Replica

Unaffiliated Vite + React UI inspired by the GMGN AI Trader demo, with a local Express backend.

## Trading modes

| Mode | Behavior |
|------|----------|
| SHADOW | Mock UI / intent only |
| PAPER (SOL) | Persistent virtual portfolio using fresh quotes and modeled costs/exits |
| **SOL LIVE** | Jupiter builds an **unsigned** swap; **your wallet** signs (Phantom / Solflare) |
| Other chains LIVE | Quote + copy intent only — no in-app submit |

This process **never** stores or uses `GMGN_PRIVATE_KEY`.

## Hard rails

1. `GMGN_LIVE=1` required for `/api/sol/*` and legacy quote routes; this does not enable broadcast
2. `GMGN_SOL_BROADCAST=1` is a separate, default-off opt-in required to forward Solana `sendTransaction`
3. Every `/api` route except sign-in needs a signed-in account (see **Sign-in**), and `X-GMGN-Token` (from `GMGN_LOCAL_TOKEN` in `server/.env`) is still required on top for credentials and LIVE routes
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
git clone https://github.com/xAc30x/GMGN-AI-Trading-Replica.git
cd GMGN-AI-Trading-Replica
npm install
# Keep both actual-service execution gates disabled.
unset GMGN_LIVE GMGN_SOL_BROADCAST
npm run dev:all
```

Open http://localhost:5173/ (or http://127.0.0.1:5173/; Google sign-in needs `localhost`)

1. Sign up with an email on your allow-list (see **Sign-in** below)
2. Paste `GMGN_LOCAL_TOKEN` from `server/.env` into **Credentials**
3. Connect **Phantom** or **Solflare**
4. Keep both execution gates unset. LIVE/PAPER service routes remain disabled in this setup.
   Automated tests use isolated loopback fixtures that never submit a real trade.

Optional secrets file: the server reads `GMGN_API_KEY` and `GMGN_WALLET_ADDRESS` from
`~/.config/gmgn-trader/secrets.json` if it exists (set `GMGN_SECRETS_PATH` to use another location).
The file lives outside the repository, so it is never committed. Format:

```json
{ "card": { "GMGN_API_KEY": "...", "GMGN_WALLET_ADDRESS": "..." } }
```

Restrict it to your user with `chmod 600 ~/.config/gmgn-trader/secrets.json`. Values already set in the
environment or `server/.env` win over the file. `GMGN_PRIVATE_KEY` is never read from it.

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

## Sign-in

The app opens on a sign-in page. The dashboard and every `/api` route (except the sign-in
routes themselves) need a signed-in account. All accounts share the same dashboard and portfolio.

**Who can sign up:** only emails listed in `GMGN_ALLOWED_EMAILS` (comma-separated) in `server/.env`.
An empty list means nobody can sign up or sign in. Removing an email ends that account's access
on its next request. The server prints how many emails are on the list when it starts.

```
GMGN_ALLOWED_EMAILS=you@example.com
```

**Email and password:** passwords need at least 12 characters and are stored only as salted scrypt
hashes in `server/.auth.sqlite` (owner-only file, git-ignored; set `GMGN_AUTH_DB_PATH` to move it,
and include it in backups). There is no "forgot password" or email verification yet.

**Sessions:** a random session id in an `HttpOnly`, `SameSite=Lax` cookie (also `Secure` when
`NODE_ENV=production`), valid for 7 days; only its hash is stored. Sign out from **Settings**.
After 5 wrong passwords for one email, or 20 failed attempts from one address, sign-in is blocked
for 15 minutes. These counters reset when the server restarts.

**Google and Apple (optional):** each button is off until its settings are present. A partial
setup stops the server at start with a message naming what is missing. Only emails the provider
has verified and that are on the allow-list can sign in; an existing account with the same email
is joined, not duplicated.

| Setting | Used for |
|---|---|
| `GMGN_PUBLIC_URL` | The address you open the app at, e.g. `http://localhost:5173` or `https://trader.example.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google (redirect URI: `<GMGN_PUBLIC_URL>/api/auth/google/callback`) |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH` | Apple (return URL: `<GMGN_PUBLIC_URL>/api/auth/apple/callback`; https only, never localhost) |

The Google values may also go in the secrets file's `"card"` (see **Run**). Keep Apple's `.p8` key
in `~/.config/gmgn-trader/` with `chmod 600`; `*.p8` files are git-ignored.

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

Broadcast-boundary acceptance checks run with `npm run test:broadcast-safety`
and are also included in `npm test`. All 10 previously failing safety cases now
pass, with additional expiry, recovery, concurrency, and close coverage. See
[the validation record](docs/validation/broadcast-boundary-2026-09-29.md) for
fixture isolation, reproduction commands, results, and remaining limits.

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
- Every LIVE buy/close build now saves an immutable authorization for the exact
  unsigned v0 message, requested wallet, server-owned quote and expiry. Close
  requests require `tradeId`, just like buys. PAPER builds receive no authorization.
  Changed messages, missing authorizations and expired builds cannot broadcast.
- Broadcast authorization and replay claims use SQLite `BEGIN IMMEDIATE`,
  `synchronous=FULL`, and mode 0600. The file is `server/.trade-ledger.json.sqlite`
  by default, or `GMGN_TRADE_LEDGER_PATH` plus `.sqlite`. Old JSON claim IDs,
  payload hashes and known signatures migrate once as blocking tombstones; the
  JSON file is retained. Malformed legacy data or corrupt SQLite fails closed.
  Message hashes and signatures cannot be reassigned to other trade IDs.
- Before dispatch, the signature is durably claimed and a buy must still have its
  matching active portfolio reservation. Same-ID accepted retries return the exact
  cached signature. Pending/uncertain claims never dispatch again automatically,
  including after restart or an RPC error/malformed response/signature mismatch.
  The proxy forces preflight on and RPC `maxRetries=0`.
  Keep both SQLite ledgers on persistent local storage shared by all backend
  processes. They are not a distributed transaction or multi-host system; restore
  consistent backups only with broadcasting disabled. Old unsigned builds must
  be rebuilt through the updated service; do not erase claims to retry a trade.
- Before wallet approval, the browser independently decodes the unsigned v0 message,
  resolves every address lookup table, checks wallet authority and trade-mint accounts,
  accepts only the supported Jupiter Route exact-in instruction (up to five known
  route steps) and approved setup programs,
  matches exact amounts/slippage/minimum output, and bounds network/platform fees.
  Unexpected transfers and unsupported instructions fail closed.
  Exact-message binding does not prove that the provider originally constructed
  the correct transaction. Full positional Jupiter account-schema validation
  remains separate work; the existing browser policy is not a comprehensive audit.
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
automated real-money exits are not implemented. No trade should be submitted against real services until those
boundaries are separately reviewed and authorized.

### Private production deployment

Step-by-step server setup (Ubuntu, Caddy HTTPS, systemd service, nightly backups):
[docs/DEPLOY.md](docs/DEPLOY.md). Server config files are in `deploy/`.

Build with `npm ci --ignore-scripts` and `npm run build`, then run
`NODE_ENV=production GMGN_LIVE=0 npm run server`. The backend serves the built
frontend and API together at http://127.0.0.1:8787. It binds only to loopback.
Keep LIVE disabled until separately authorized and validated. Production serving
does not expose the source tree; unknown API routes remain 404.

In production the session cookie is `Secure`, so open the app through its HTTPS
address (the reverse proxy), not plain `http://127.0.0.1:8787`, or sign-in will not
stick. The reverse proxy has no separate password page; app sign-in protects the app.
Back up the account database with the other databases (the nightly backup in
`deploy/` covers it).


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

## Persistent research and paper portfolio

Discovery now saves each successful feed scan in `server/.research.sqlite` (override
with `GMGN_RESEARCH_DB_PATH`). The SQLite database is separate from real-trade
reservations, permissioned to 0600, and excluded from Git. Keep it on persistent
local storage and back it up with the server stopped. Importing the app does not
create the database or start a monitor.

Each scan records up to 30 Solana candidates in provider feed order, including
liquidity rejects, missing-market-data candidates, and failed safety checks. The
UI still shows at most 15 candidates meeting the discovery liquidity floor.
Watchlist scans are also saved with market snapshots where available.
Snapshots retain the feed, time, market fields, safety decision/reasons and
`safety-only-v1` strategy identifier. These are observations from the selected
feeds, not an exhaustive market sample, and repeated scans are not independent
trades. Scans are collected when discovery is requested (normally every 60s while
the discovery tab is visible), and by the background scheduler described below.

The executable backend checks pending 5m, 1h and 24h USD-price outcomes every 15s.
Prices are observed on/after the target time, within a two-minute window. Missing
prices are unknown, and missed windows after downtime are labeled `missed` rather
than backfilled with current prices. These market returns exclude trading costs
and are distinct from paper P&L. Both accepted and rejected candidates are tracked.

SOL PAPER now opens durable virtual positions through the dedicated paper API;
it does not build a transaction or require a connected wallet. This replaces the
UI's one-shot RPC simulation; the existing low-level simulation helper remains
available. There is one shared manual paper account per backend database, alongside isolated
strategy experiment accounts. The manual account starts
with **1 virtual SOL**, at most **5 open positions**, and one open position per
mint. The existing server per-trade amount cap also applies. Request IDs make
entry retries idempotent; cash debits, credits and position changes use SQLite
transactions. Closed positions and entry/exit failure events are retained.

The explicit, unvalidated `quote-min-output-v1` model uses:

- Fresh mint safety checks before entry, then a **1s delay** and a server-owned
  Jupiter ExactIn quote. No browser-supplied price or quantity is trusted.
- Quote minimum output on entry **and** exit to model adverse slippage. Price
  impact and route trading fees are already reflected in the quote; no extra
  percentage fee is added on top.
- **0.00001 SOL estimated network/priority fee per side**, plus **0.00203928 SOL
  estimated entry account rent**, conservatively assuming no rent refund. These
  are model assumptions, not measured transaction fees or exact account costs.
- Full-position exits at **-20% net P&L**, **+30% net P&L**, or **60 minutes**, plus
  manual close. Each exit obtains another quote after the delay, so the simulated
  fill can pass a stop/target. Positions retain their model parameters across restarts.
- No fabricated fill on quote failure: the position stays open and a triggered
  exit remains pending for retry, including after restart. Provider failures are
  treated as no attempt reaching the chain, so no execution fee is charged for
  those failures. Transaction-level failure probability, MEV, and actual priority
  fee variability are not modeled.

Monitoring continues while the executable backend and existing `GMGN_LIVE`
market-service gate are enabled, even when the browser is closed. No broadcast
flag is required or changed. With the service gate off, stored history and account
state remain readable, but entries, closes and monitoring pause. Restart the
backend after installing this change. Runtime flags are not enabled by installation.
The research panel appears in SOL PAPER/LIVE; PAPER buys create virtual positions,
while LIVE buys retain the wallet-signed execution path.

Marks older than 45s or failed quotes do not count as fresh equity. Net realized
P&L includes entry rent and modeled fees on both sides. Aggregate stats cover all
trades; the UI shows all open positions plus recent closed positions (100 total), and 30 scan observations. These
results validate the simulation assumptions, not profitability in real execution.

| Endpoint | Behavior |
|---|---|
| `GET /api/research/scans?limit=50` | Authenticated scan history; max 100 rows. Page using the last row's `at` as `before` and `id` as `beforeId`. |
| `GET /api/paper/portfolio` | Authenticated persisted cash, positions, metrics and recent events. |
| `POST /api/paper/open` | `{id, mint, symbol, amount, slippageBps}`; virtual entry only. |
| `POST /api/paper/close` | `{id}`; full virtual exit, idempotent after close. |
| `POST /api/paper/refresh` | Refresh marks/outcomes, throttled to one run per 15s. |

All paper writes require the existing service gate and access token. The automatic
research monitor only reads provider data and mutates this local research database;
it cannot sign or broadcast. Automated tests use temporary databases, fake clocks,
mocked providers and browser API fixtures, never real trades.

## Background discovery and prospective paper comparison

When the executable backend is running with the existing market-data service gate
(`GMGN_LIVE=1`), it schedules both **Top boosted** and **Latest profiles** every
120 seconds by default. `GMGN_RESEARCH_SCAN_SECONDS` accepts 60–3600 seconds. The
browser is no longer required for discovery collection. No runtime execution
flags are changed by installation; `GMGN_SOL_BROADCAST` is unrelated to research.

The SOL research panel shows scan status, last attempts, next runs, provider
errors, and independent pause controls. Background scans default on; automatic
paper entries **default paused**. **Start paper comparison** enables the two
virtual portfolios until paused, with that choice saved across restarts. Pausing
scans or entries prevents an in-flight automatic entry from committing. In-flight
read-only scans may finish. Existing virtual positions still receive marks and
exits while the service gate is enabled; pausing new entries does not strand them.

Scheduler due times, failures and five-minute ownership leases are persisted in
SQLite. A process restart respects the stored schedule; an interrupted scan is
eligible again when its lease expires. Failed feeds use exponential backoff capped
at 30 minutes. UI and scheduler requests share in-flight work and a 60-second
result cache. Discovery and exit monitoring run independently. History has a
market-observation timestamp as well as the completed scan timestamp, so slow
screening cannot silently make an old signal fresh.

Two immutable experiment versions receive separate **1 virtual SOL** balances:

| Version | Selection rule |
|---|---|
| `momentum-quality-v1` | Highest eligible opportunity score, using only that scan's market and safety inputs. |
| `safety-feed-v1` | First eligible safety-passing token in original provider feed order, with positive price and liquidity. |

Both use **0.01 SOL entries**, **100 bps slippage**, at most **3 open positions**
per account, one attempted entry per feed scan, and a **24h per-coin cooldown**
(including closed positions). They use the same fee, rent, delay and exit model as
the manual portfolio. A candidate's market observation must remain no older than
120 seconds at fill time. Both strategies re-run mint safety and obtain a fresh
server-owned quote. Each decision records its scan, observation, version, inputs,
selection/skipping/failure reason, and deterministic trade ID. Retries cannot
spend virtual cash twice. Manual trades and their balances are preserved by the
SQLite migration and remain isolated from these experiments.

The initial ranking is a **research hypothesis**, not an AI probability estimate:

- Safety must pass; missing required numeric inputs produce WATCH, not an invented score.
- Liquidity at least $25k; pair age 30 minutes through 7 days.
- At least 30 transactions in 1h; buy transaction share at least 55%.
- 1h price change above 0% through 30%; 5m change from 0% through 15%.
- Positive 1h and 5m volume, with an overall score of at least 60/100.
- Four components, each capped at 25 points: liquidity / $100k; (buy share − 0.5)
  / 0.2; (5m volume × 12 / 1h volume) / 2; and 1h price change / 10.

Volume acceleration compares two overlapping windows; transaction counts are not
unique buyers, and neither detects wash trading. Pair age is not necessarily token
age. Boosts and profile listings are a biased candidate universe. These defaults
have not been optimized or validated. Manual buys remain separate from the ranking.

The comparison reports net expectancy per **closed** trade, profit factor, open
and closed counts, realized P&L, total P&L using fresh marks, and **sampled** maximum
equity drawdown. Missing marks make current total P&L unknown and are counted;
drawdown can understate intraperiod or outage losses. Zero losses are labeled
without inventing an infinite profit factor. Fewer than 30 closed trades are
explicitly labeled insufficient; 30 trades does not establish significance.

This is forward evaluation of fixed rules on outcomes that occur after selection.
Ranking never reads the recorded future-return table. There is no fitted model,
historical strategy optimizer, walk-forward tuning, or proven edge yet. Both
experiments share the candidate scans, but may abstain differently or obtain
slightly different quote times; this is a portfolio-policy comparison, not a
claim of identical fills or equal trade counts. Experiment definitions are stored
with the accounts; changing a definition requires a new version rather than
mixing incompatible results. Retired versions remain visible and their existing
positions continue to be monitored; only current versions receive new entries.

Additional authenticated routes:

- `GET /api/research/automation`: settings, persisted job status, portfolios,
  comparison metrics and recent decision receipts.
- `POST /api/research/automation`: a partial `{scanning: boolean, autoPaper: boolean}`
  update. It changes virtual research controls only and cannot change service or
  broadcast gates. Pause is available even when the market-data gate is off.

Use persistent local storage and one running backend for predictable timing.
Database leases and atomic fills protect against duplicate workers, but this is
not a distributed research platform. Tests cover browser-free scheduling,
restart/backoff/lease recovery, stale signals, concurrent workers, in-flight pause,
legacy data migration, account isolation and forward-only scoring with fixtures.
