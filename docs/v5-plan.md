# Mako Markets V5 — planning doc

> **Status:** draft, pending v4 beta data.
> **Author:** written during v4 hardening rounds (2026-04-24) as a capture of
> design decisions that didn't make the v4 cut.

This document captures what Mako will build **after** v4 ships into private
beta and comes back from the first professional audit. The motivation, the
design, the reasons we chose what we chose, and (most importantly) the
reasons we explicitly **didn't** do certain things in v4.

If you are reading this to decide what to build next, start with "Decision
framework" at the bottom.

## What v4 leaves unsolved

v4 ships with:

- Hard betting cutoffs per market type (FOOTBALL / BASKETBALL close at
  kickoff; CRYPTO closes at 50%–85% of duration based on tier)
- Per-wallet pool share cap (default 20%, admin-configurable)
- Per-wallet absolute bet cap (admin-configurable, tiny during beta)
- Minimum seconds between bets from the same wallet on the same market
  (30s)
- Admin-writable blocklist for abusive wallets
- Minimum market duration (5 min) so creators can't ship degenerate
  micro-markets

What v4 **cannot detect**, fundamentally:

- **Stale crypto markets.** A 7-day "Will ETH > $3500?" market where ETH
  jumps to $3800 on day 2 via a news event. The contract has no way to see
  that ETH moved. Late bettors can pile in on the already-decided outcome.
  Hard cutoffs help but don't fully close the window.
- **Insider / informed betting.** Someone with private info betting on a
  "certain" outcome looks identical on-chain to someone with a strong
  opinion. No heuristic distinguishes them.
- **Sophisticated sybil patterns.** Fresh-funded wallets with varied
  timing that spread a coordinated position across N addresses. The cap
  + rate limit defenses raise the cost but don't eliminate the pattern.

V5 addresses the first of these. The second and third are harder and
deferred even further.

## V5 scope — two additions, both contingent on v4 beta data

### V5.1 — Pyth-based early resolution for CRYPTO markets

**Feature:** A new `triggerPriceResolution(id, pythPriceUpdateData)` function
that anyone can call. It:

1. Asserts the market is a CRYPTO type with a parseable threshold in
   `oracleRef` (e.g., `"ETH:gt:3500"`)
2. Submits the provided Pyth price update to the Pyth contract (paying
   Pyth's update fee from the caller's msg.value)
3. Reads the freshly-updated price for the asset
4. Checks whether the price has been clearly past the threshold
   (±5% buffer) for a minimum continuous duration (1 hour)
5. If yes, resolves the market with the implied outcome (YES or NO)

**Why this and not dynamic per-bet odds:**
- Per-bet oracle reads are N× the attack surface vs one-at-resolve
- Per-bet gas overhead degrades UX
- Oracle manipulation in the mempool has a known class of bundled-
  update exploits (e.g., Mango Markets 2022, loss $117M)
- "Resolve early when outcome is obvious" captures 90% of the value
  with 10% of the risk

**Architectural constraints:**
- Pyth must be live on Monad mainnet with the specific feeds we need
  (ETH/USD, BTC/USD, SOL/USD at minimum). Needs due diligence as a
  precondition — if feeds are missing, this whole path falls back to
  "accept staleness and monitor via MakoSentinel alerts only."
- Contract updates to accept `bytes calldata pythPriceUpdateData` on the
  trigger and forward to `IPyth(pyth).updatePriceFeeds`
- New state per market: `lastPriceBeyondThresholdAt` tracks how long the
  price has been past threshold (updated on each trigger call)
- Access control: anyone can call the trigger, the contract verifies
  independently. No trusted role required.

**Audit concerns to flag to the auditor:**
- Pyth update bundling — can an attacker bundle a stale/manipulated
  update into the same tx to control which price the contract sees?
- Staleness check: `publishTime` on the Pyth response must be within
  an acceptable window
- Price deviation check: we should refuse resolution if the latest price
  deviates >X% from a recent TWAP

### V5.2 — MakoSentinel off-chain analyst service

**Feature:** A CF Worker service (same infra as the existing
`mako-auto-resolver` worker) that monitors on-chain state plus Pyth feeds.

Responsibilities:
1. For every CRYPTO market: poll Pyth, call `triggerPriceResolution(id)`
   when conditions match. This is the **defender** role — no privileged
   access; anyone could do it, Sentinel just does it automatically.
2. For every market: compute manipulation alert signals and emit to a
   `#mako-alerts` Slack channel:
   - Single wallet ≥ 25% of pool (above the on-chain cap — this would
     mean the cap was raised or the alert threshold is stricter)
   - Same-source-funded wallets clustering on one side
   - Bet rate > 10× baseline in a 5-minute window
   - Bet placed within seconds of an on-chain price move

**Explicit non-responsibilities:**
- **No privileged access to the contract.** Sentinel's contract
  interactions are limited to the same public `triggerPriceResolution`
  that any wallet can call.
- **No bet gating.** Sentinel cannot reject or approve individual bets.
  If Sentinel is offline, users bet and claim normally.
- **No odds adjustment.** Parimutuel math stays unchanged.

**Why analyst-only:**
- Avoids the "bookmaker pivot" — agent-as-active-gate requires regulatory
  classification as a sportsbook in most jurisdictions
- Avoids the trust model regression — compromised agent signing key
  means grief attacks on every market simultaneously
- Avoids availability risk — Sentinel down ≠ users can't play
- Matches what mature prediction markets (Polymarket, Kalshi) actually
  do in ops

### What V5 explicitly does NOT include

Catalogued here because these ideas came up during v4 design and we
rejected them for v5. If someone revisits these, they should understand
why they were deferred rather than not-considered.

- **Per-bet dynamic odds via Pyth.** Rejected: per-bet oracle reads are
  attack-surface-multiplied. Catch stale markets at resolution time via
  V5.1, not at bet time.
- **On-chain ML models for manipulation detection.** Rejected: EVM ML
  inference is impractical (floating-point cost, storage cost). Compiled
  decision trees are just if/else rules — write the rules directly.
- **Agent-as-bookmaker (active bet gating).** Rejected: trust model
  regression, liveness risk, regulatory classification risk.
- **On-chain wallet clustering / sybil detection.** Rejected: signal is
  too noisy without external context. Do cluster analysis off-chain in
  MakoSentinel and surface to a human for judgment.
- **Dispute-resolution oracle (UMA-style).** Not rejected, deferred to
  V6+. Requires a separate token/stake economy and more audit surface
  than V5 should add in one step.

## Prerequisites before V5 can ship

1. **v4 ships** and spends at least 2 weeks in private beta with real
   bets.
2. **Professional audit of v4 complete** with all findings addressed.
   V5 will get its own audit, but we don't want v4 findings leaking
   into V5's implementation.
3. **Beta telemetry review.** Concretely:
   - How many stale-market exploitation attempts did we see? (If zero
     in 2 weeks with 10–30 testers, V5.1 priority drops.)
   - How many manipulation alerts would MakoSentinel have fired if it
     existed? (Proxy for how useful it'd be.)
   - How often did `forceRefund` get invoked and by whom? (Proxy for
     resolver reliability.)
4. **Pyth-on-Monad due diligence:**
   - Pyth deployed on Monad mainnet at known addresses
   - ETH/USD, BTC/USD, SOL/USD feeds with acceptable staleness bounds
   - Update fee cost is predictable (<$1 per trigger call)
   - If any of the above fail, V5.1 degrades to MakoSentinel-alerts-only
     (no auto-resolve, human admin action on stale markets)

## Decision framework

When considering a V5 design change or addition, run through this
checklist:

1. **Does this introduce a new privileged role?** If yes — pause. Explain
   how the contract enforces correctness independently of that role. If
   the role has unchecked power over user funds, the answer is probably
   no.
2. **Does this introduce a new oracle dependency?** If yes — does the
   feed exist on Monad? Is there a fallback path when the oracle is
   stale/down? Has the pattern been audit-reviewed?
3. **Does this change parimutuel payout math?** If yes — strong
   justification required. Payout math changes turn user expectations
   and turn up audit findings.
4. **Can this be done off-chain?** If yes — do it off-chain first. On-chain
   costs gas, bloats audit surface, and is hard to iterate on.
5. **Does beta data justify this?** If no beta data supports the need,
   defer until beta data exists. Speculative features burn audit budget.

## Snapshot of v4 as of this doc

For future-self context. Current v4 state at time of writing:

- `MakoMarketsV4.sol` at `0x3C965Af03b273472e7288cae875dC2CFC57919E0` on
  Monad testnet (stale — will be redeployed after the current hardening
  round: cutoffs, caps, rate limits, blocklist)
- Deploy helper: `mako-contracts/deploy-v4.ps1`
- ABI synced at `mako-markets/scripts/mako-v4-abi.json` +
  `cf-worker/src/mako-v4-abi.json` (both will be re-synced after
  redeployment)
- 38 Foundry tests passing (will grow with V4 hardening tests)
- Three Codex adversarial review rounds applied; professional audit not
  yet engaged.

## References

- Plan file (full onboarding rebuild): `logical-dancing-liskov.md`
- Safe / Path X: `safe-address-decision.md`
- DB migrations policy: `db-migration-policy.md`
- Pyth on EVM docs: https://docs.pyth.network/price-feeds/contract-addresses/evm
- Mango Markets incident write-up (oracle manipulation):
  https://www.halborn.com/blog/post/explained-the-mango-markets-attack-october-2022
