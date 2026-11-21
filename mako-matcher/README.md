# mako-matcher

The off-chain order matcher for Mako Market's own markets: a Cloudflare Worker with one Durable Object per market.
Design: `.claude/design/OFFCHAIN_MATCHING_PLAN.md` r31 draft 7 (slice 2). It talks to `MakoOutcomeExchangeV1`
(`mako-contracts` branch `feat/outcome-exchange-v1`, commit `e386bf4`).

**Status: phase A. Nothing is deployed, no key is funded, no user trades.** The settler is a stub that sends
nothing.

## What is built (phase A)

- **Order model** (`src/order.ts`): the plan 4.1 typed data, the order hash, and local signature recovery with
  exactly the contract's step-1 rules (65 bytes, low `s`, `v` 27 or 28). viem's own recovery is more lenient, so it
  is only called after those checks.
- **Routing and market identity** (`src/index.ts`, `src/routing.ts`, `src/market.ts`): market ids are canonical
  decimal; `env.MARKET.idFromName(<id>)` is the only way to reach a market; the market id is stored on the first
  request only after `idFromName(id)` equals the object's own id; a later request naming another market is refused
  and alerted.
- **Intake** (`src/intake.ts`): plan 6.2 "Place an order", with stable refusal codes (below). One multicall reads the
  market, the nonce, the order's own state and the maker's cash or shares. The final checks (cap, reservations,
  duplicate) and the insert happen in one synchronous block, so two orders in flight cannot both pass.
- **Supported wallets** (`src/wallets.ts`): plan 4.6, known code only. A signature that does not recover its maker
  is accepted only from a Mako email Safe (code hash, singleton slot and fallback-handler slot read with
  `eth_getCode` and `eth_getStorageAt`, signing 65 bytes with `v` 31 or 32), then checked by the exchange's own
  `isValidOrderSignature` with a 1,000,000 gas allowance.
- **Book and matching** (`src/book.ts`, `src/match.ts`): one SQLite row per order and signature; price-time
  priority; self-trade skipping; direct, mint and merge proposals with the per-kind fill rule. It never proposes a
  mint or merge whose maker prices sum above 100, a match across markets, a party in the contract's refused roles
  (read from the contract), or more than 10 makers.
- **Hand-off** (`src/market.ts`): a proposal goes to the settler only through `env.SETTLER.idFromName("settler")`.
  In phase A the stub refuses it and the order stays booked. At most one hand-off per pass.
- **Cancels and expiry**: `DELETE /market/:id/orders/:hash` with the shared secret in `x-matcher-secret`; on every
  alarm tick `Cancelled` and `NonceIncremented` logs are read (100-block chunks, at most 5 per tick) and the affected
  orders dropped; expired orders are dropped.
- **Book feed**: `GET /book/:id`, aggregated price levels only, from a Cache API copy at most 2 seconds old.
- **Vendored inputs** (`data/`, `scripts/vendor.mjs`): the exchange ABI, `order-abi.json` and the Safe v1.4.1
  factory code, each with a sha256 sidecar; `--check` fails on drift from the `mako-contracts` checkout at the
  recorded commit. `SafeProxy.runtime.hex` is derived (how, in `scripts/vendor.mjs`).
- `RUNBOOK.md`: plan 6.5, copied verbatim.

## HTTP surface

| Route | Does |
|---|---|
| `POST /market/:id/orders` | body `{ order: {...}, signature }`; large integers are canonical decimal strings |
| `DELETE /market/:id/orders/:hash` | off-chain cancel; `x-matcher-secret`; 503 with no secret configured |
| `GET /book/:id` | the feed |

Refusal codes: `bad_request`, `wrong_market`, `bad_expiration`, `expired`, `bad_price`, `bad_size`,
`size_below_minimum`, `bad_signature`, `signature_too_long` (copy C5), `signature_check_failed` (C5),
`unsupported_wallet` (C7), `market_not_open`, `market_closed`, `bad_option`, `nonce_mismatch`, `order_cancelled`,
`order_filled`, `account_refused_today`, `duplicate_order`, `too_many_orders`, `insufficient_cash`,
`insufficient_shares`; 503: `not_configured`, `chain_read_failed`, `refusal_list_unavailable`.

## Not built yet (operations track)

Plan 10.1 `[r28]`: no product key is funded, nothing is deployed and no user trades until the operations track is
approved. These are left out on purpose:

- `mako-matcher/scripts/topup.mjs`, its reconciliation, baselines and theft alert (plan 6.3 steps 1 to 3);
- the release check of plan 10.3, and every test that needs it or the helper (release check, funding bound,
  reconciliation, top-up flow, baseline from the chain, retired keys, rotation and the day's clock, identity loss);
- `epsilon` and anything that reads it.

`wrangler.toml` therefore leaves `EXCHANGE_ADDRESS`, `K` and `FUNDER_ADDRESS` unset and has
`GATE_GT_PASSED = "false"`; `scripts/assert-bundle.mjs` fails if any of them is set.

## Not built yet (phase B, the settler)

Encoding from records, traced simulation, the 4,026,000 ceiling, send and receipt, trace read, the full plan 6.2
revert table and blame rules, N = 1 / N = 3 (the settler's `refused_accounts` table exists and is read at intake;
nothing writes it yet), daily counters, wallet short, send log, single in-flight with crash recovery and key-change
wait, the one-send-path check on the real send code, and dropping a market's orders when trading closes.

## Registered order signer (plan 4.5): not built

The contract at `e386bf4` has no `setOrderSigner` (plan Q10: only if S1's fallback fires). So there are no
`orderSigner` reads, no registered path at intake, no `OrderSignerSet` handling and no P1r (aj) test. The code
refuses any signature the contract would not accept today: a Safe-form signature is accepted only for a supported
wallet, and a plain `v` 27 or 28 signature must recover the maker.

## Running the gates

```
cd mako-matcher
pnpm install --frozen-lockfile --ignore-workspace
pnpm typecheck          # src and test
pnpm test               # vitest in workerd (the real Durable Objects, a fake chain, no network)
pnpm test:scripts       # node --test for scripts/vendor.mjs and scripts/assert-bundle.mjs
pnpm check:vendored     # vendored inputs vs sidecars (and vs the mako-contracts checkout where present)
pnpm bundle && pnpm assert-bundle
```

Tests use made-up bindings from `vitest.config.ts` (a test exchange address, an RPC host that does not exist) and a
fake node built from the real ABI (`test/fake.ts`); nothing leaves the machine. Every key in the vectors is derived
from a public label.
