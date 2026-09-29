# Broadcast-boundary validation — 2026-09-29

Status: **FAIL — live trading remains blocked.** This change adds acceptance
tests, not an execution fix. Keep this work in draft until the failures are
resolved. No production/runtime flags or credentials were changed.

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
