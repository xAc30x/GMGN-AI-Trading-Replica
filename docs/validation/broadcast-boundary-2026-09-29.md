# Broadcast-boundary validation — 2026-09-29

Current status: **PASS for transaction binding and replay acceptance; no live
trading clearance.** The follow-up implementation described below resolves the
10 original failures. The original baseline findings are preserved afterward.
No production/runtime flags or credentials were changed.

## Remediation follow-up

Implemented on the PR #5 validation branch, based on commit
`fa245f866906bef6eda313a925a46cf8e74f3a67`:

- Immutable authorizations bind each LIVE build's exact message, wallet, quote
  intent and expiry to its trade ID. Both buy and close paths authorize; PAPER does not.
- Broadcast checks the cryptographic signature and message identity, obtains a
  fresh block height, and atomically claims the signature before network dispatch.
- SQLite message/signature uniqueness and `BEGIN IMMEDIATE` serialize claims
  across processes. Pending claims survive restart and never automatically replay.
- Buys require a matching active reservation before sending. Caller-supplied RPC
  options cannot disable preflight or enable retries. Unexpected upstream results
  remain uncertain; only the exact expected signature can enter the accepted cache.
- Legacy JSON IDs, signed-payload hashes, and known signatures migrate once as
  blocking tombstones, without deleting the original JSON.

Validation with Node 24.19.0:

| Check | Follow-up result |
| --- | --- |
| HTTP broadcast-boundary suite | 27 passed, including all original 17 tests |
| Durable ledger suite | 5 passed, including independent-process race and restart |
| Full `npm test` | 105 passed, 0 failed, 0 skipped |
| Production build | Passed; existing bundle-size warning |
| Lint | Zero errors; six existing React warnings |
| Whitespace check | Passed |

Two older route fixtures were corrected: placeholder unsigned strings now use
serialized transactions, and successful broadcast fixtures create a LIVE
authorization and return the real test signature. Their assertions remain in
place. None of the original 10 rejection assertions were weakened or skipped.

`npm run test:broadcast-safety` runs both the HTTP and durable-ledger suites.
Browser tests were not revalidated in this follow-up: Chromium installation was
blocked in the preceding audit. No real provider transaction or deployment was
performed. Message binding prevents changes after the server build; it does not
prove the original provider message implements the quote, solve every Jupiter
account-schema issue, or establish profitability. Separate database transactions
fail closed across crash boundaries but are not a distributed atomic commit.

The sections below record the **historical failing baseline**, not the current
test outcome.

## Baseline and scope

Validated published `main` at `1b1e4ca55b2555c86cd0d4aea541582bd27b93dc`,
whose direct parent is PR #4 merge `c85fd9c415419413ffbefe42e4118872cf6c3754`.
The new suite exercises the actual Express build and broadcast handlers with
isolated local provider fixtures. It tests whether a signed message is bound to
the server-built trade, and whether retries can cause additional RPC dispatches.

## Reproduce

In an isolated checkout with Node >=22.13 (this run used Node 24.19.0):

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run test:broadcast-safety
npm test
```

No environment flags or funded wallets need to be configured. The suite is
included in the existing `npm test` glob; it is not skipped, marked TODO, or
converted into an expected-success assertion of unsafe behavior. This makes it
a local acceptance gate, not a GitHub branch-protection rule or a deployment gate.

## Results

| Check | Result |
| --- | --- |
| New broadcast suite | 17 tests: 7 passed, 10 failed |
| Full suite | 90 tests: 80 passed, 10 failed; all 73 pre-existing tests pass |
| Lint | Zero errors; the same six existing React warnings |
| Whitespace check | `git diff --check` passes |
| Unexpected fixture errors/network attempts | Zero |

Every failing case returned HTTP 200 and caused one prohibited additional
`sendTransaction` request to the mock upstream. This proves a missing boundary
check; it does not demonstrate execution on Solana or a profitable theft exploit.

### Passing controls

- An unchanged server build forwards once; same-ID retry returns the cached signature.
- Missing authentication blocks forwarding.
- Either execution gate set to zero blocks forwarding.
- An invalid cryptographic signature blocks forwarding.
- Different bytes under an accepted trade ID block a second dispatch.
- A lost upstream response blocks same-ID retry and retains uncertainty.

### Failing acceptance criteria

Each case requires a 4xx rejection and **zero additional upstream sends**:

1. Signed transaction with no server-built trade authorization.
2. Different signing wallet under an existing trade ID.
3. Output mint and destination changed after the server build.
4. Input amount changed from 0.01 to 0.02 SOL, still inside the 0.05 SOL cap.
5. Input amount changed to 0.1 SOL, above that cap.
6. Source/destination account roles swapped while both accounts remain present.
7. Unrelated SOL transfer appended after the build.
8. A signed transaction from the legacy unsigned PAPER-build route submitted for broadcast.
9. An accepted signature replayed under a second valid LIVE reservation/trade ID.
10. A signature with a lost response replayed under a second valid LIVE reservation/trade ID.

The PAPER case concerns the legacy `/api/sol/swap-tx` `mode: PAPER` path;
the dedicated virtual paper engine still does not sign or broadcast. Replaying
identical signed bytes is evidence of repeated application-level dispatch, not
proof that Solana executes the same signature twice.

## Isolation and limitations

- Fresh, unfunded test keypairs are generated in memory and never persisted.
- Provider URLs point to one ephemeral loopback fixture. A socket-level guard
  permits connections only to that fixture and the ephemeral application server.
- LIVE/broadcast flags are opened only inside this guarded test process to reach
  the handler. They are reset between tests and restored on cleanup.
- JSON/SQLite state uses a temporary directory with per-case ledger paths.
- Importing the app does not run executable startup or background monitoring.
- The synthetic Jupiter-shaped message mirrors existing policy fixtures. It is
  a message-binding fixture, not a validated on-chain Jupiter transaction.
- These tests do not cover multi-process journal races, real provider behavior,
  browser signing, every Jupiter account schema, or crash recovery across stores.

## Remediation target

Before considering live validation, bind broadcast authorization to the exact
server-approved message and its wallet, trade intent, mode and expiry; reject
missing or mismatched authorizations before dispatch. Preserve idempotency across
trade IDs and uncertain outcomes. Validate supported instruction account roles
and transaction policy, not only signatures or account membership.

The next implementation should make these rejection tests pass while retaining
the positive and same-ID retry controls. Do not satisfy them by disabling every
broadcast, weakening assertions, or skipping failures. Additional valid Jupiter
fixtures and schema checks are still necessary for independent transaction-policy
validation, even after message binding is fixed.
