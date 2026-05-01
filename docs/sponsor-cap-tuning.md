# Pimlico sponsor cap tuning

Operator runbook for Phase 1D bet flow + sub-phase D dev surface. Use this
when you see `503 SPONSOR_UNAVAILABLE` errors in production logs or in the
`/dev/aa-smoke` surface.

## Layered caps

Three independent caps protect the Pimlico paymaster gas tank. Each layer
has its own rejection point and its own remediation:

| Cap | Where enforced | Default | Effect when exceeded |
|---|---|---|---|
| Pimlico per-op `$/op` cap | Pimlico policy server | $0.10/op (smoke) → $0.30/op (1D bet) | Sponsor RPC returns JSON-RPC reject; route 503 `SPONSOR_UNAVAILABLE` |
| Pimlico per-user daily $ cap | Pimlico policy server | $0.50/day per Safe | Same as above |
| Pimlico monthly $ cap | Pimlico policy server | $10/month global | Same as above |
| Local count cap (`SPONSOR_CAP_PER_USER_PER_DAY`) | `aa_sponsor_limits` Postgres | 5 ops/day per (user, chain) | Route 429 `CAP_EXCEEDED`. Refund discipline preserves count for Pimlico-side rejects (refund logic lives in `src/app/api/aa/sponsor/route.ts`; the bounded decrement helper is in `src/lib/aa-sponsor-limits.ts`). |

The local count cap is a coarse second layer. Pimlico's policy server is
the dollar-truth source. The two caps are independent: a user can hit the
local count without hitting Pimlico's $ cap if their ops are cheap, and
vice versa.

## Reading current Pimlico spend

1. Sign in to https://dashboard.pimlico.io.
2. Select the Mako project (currently named `mako-testnet`).
3. **Sponsorship** tab → Monad chain.
4. Top of the page shows month-to-date spend vs the $10 cap.
5. **Activity** sub-tab lists individual sponsored ops with per-op cost.

Cache the dashboard tab — Pimlico's API doesn't expose a programmatic
spend read at the time of writing. The admin monitoring panel (Phase 5
deferred) will scrape this; until then, manual.

## When to raise the per-op cap

**Raise from $0.10 to $0.30** the first time the bet flow's first-bet user
op (Safe deploy + MultiSend wrapper + approve + placeBet) lands in
production logs as 503 `SPONSOR_UNAVAILABLE` with the underlying Pimlico
error containing `policy_violation` or `op_too_expensive`.

**Raise from $0.30 to $0.50** if you see the same 503 pattern for first
bets on chains where the Safe singleton + factory bytecode is slightly
different and the deploy gas runs higher than Monad testnet's baseline.
This is unlikely under Path X but possible on a future chain pair.

**Raise the monthly $ cap from $10** only after confirming via Activity
tab that the spend trajectory is sustainable for the user count you
expect. The cap is intentionally tight during Stage 1 / private beta to
prevent runaway spend from a misconfigured cron or a sponsorship loop
attack.

## Steps to raise the cap

1. Dashboard → **Sponsorship** → Monad chain → **Policy** tab.
2. Find the relevant cap row (`Per-op $ cap` or `Per-user daily $`).
3. Edit value, save.
4. **Redeploy is NOT required.** Pimlico's policy server applies dashboard
   changes within 60 seconds. The next sponsor request through
   `/api/aa/sponsor` picks up the new cap.
5. Verify by retrying the failing op. If 503 persists, the issue is
   elsewhere (gas tank empty, monthly cap hit, etc.). Check the dashboard
   for the specific reason.

## Steps to refill the gas tank

1. Dashboard → **Funds** → Monad chain.
2. Get the deposit address.
3. Send testnet MON from your operator wallet to the deposit address.
4. The dashboard updates the gas tank balance within ~30s.

## Rollback / lower the cap

If you raised the cap and want to walk it back (e.g., after a usage
spike subsides):

1. Same dashboard edit, lower the value.
2. **There is no soft rollout.** A user mid-bet will see a 503 if the
   new cap is below their op's cost.
3. Communicate cap drops in the operator Slack so the team isn't
   surprised by a sudden 503 wave.

## What to NOT do

- **Don't disable the policy server caps entirely.** They're the primary
  defense against a sponsorship-loop attack.
- **Don't raise the local `SPONSOR_CAP_PER_USER_PER_DAY` to "compensate"
  for Pimlico-side 503s.** The local cap is count-based; it doesn't help
  if Pimlico is rejecting on $ grounds.
- **Don't share the Pimlico API key** — it's the credential that lets
  anyone holding it sponsor ops against your gas tank.

## Related

- `.env.local.example` — Pimlico API key env var reference.
- `src/lib/aa-config.ts` — bundler URL composition; embeds the API key.
- `src/lib/aa-sponsor-limits.ts` — local count cap implementation.
- `src/app/api/aa/sponsor/route.ts` — refund discipline (PathXMismatch
  refunds; Pimlico-side rejects preserve the count).
- Pre-Stage-1 hardening checklist (in master plan) — adds programmatic
  spend alerting at 80% of monthly cap.
