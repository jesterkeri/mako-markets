# mako-rounds-keeper

A Cloudflare Worker that settles MakoRoundsV1 rounds. Every minute it takes one round that closed at least
5 minutes ago, fetches the two Chainlink Data Streams reports for its start and close seconds, simulates
`settle`, and sends it from a gas-only key. `settle` is permissionless and the contract verifies both
reports on-chain and derives the outcome, so the keeper can deliver reports but cannot choose a result.

The report fetching, round choice and calldata live in `../rounds-delivery/`, pure code the CRE workflow will
reuse unchanged (INVARIANTS N15).

## What it guarantees

- One run at a time (a Durable Object lease), so two runs never sign with the same nonce.
- Never a second transaction while the first may still land. A signed transaction is recorded under the
  lease before it is sent, so a run that crashes after sending always leaves it for the next run to check.
- Nothing is sent unless the simulation passes. A round someone else settled first counts as success.
- Rounds take turns (least recently tried first), so a round that cannot settle, say its report is missing,
  only spends its own turn and never makes later rounds miss their deadlines. After a receipt the same run
  goes on to the next round, so it takes one round every minute.
- A round whose transaction reverts on chain or is dropped twice is no longer sent (it would only burn gas).
- `settle` above 1,000,000 gas is refused (SPEC §5.5a).
- Every run ends in one status (below). Unhealthy for 4 minutes from the run that first saw it pings
  Healthchecks `/fail`; a keeper that stops running is caught by Healthchecks' missing pings. `sent` and
  `tx-pending` never end an unhealthy stretch, so a transaction that reverts every time still alerts.
- An **alarm** rides on every run while any pending round is 30+ minutes past close or has stopped being sent,
  so a failing round cannot hide between other rounds' healthy runs.
- No key, secret or URL in any log line, status, ping or stored state (tested).
- `DRY_RUN` is on unless it is exactly `"false"`.

## Statuses

Healthy, and ending an unhealthy stretch: `settled`, `nothing-due`, `dry-run-would-send`, `waiting-report` (a
report is not published yet), `already-settled`. Neutral: `sent`, `tx-pending`, `lease-held`.

Unhealthy: `rpc-rate-limited`, `rpc-error`, `report-api-error`, `report-missing-30m`, `simulation-reverted`
(with the contract error's name), `gas-over-budget`, `low-gas-balance` (cannot pay for this settlement),
`sent-low-gas` (sent, but fewer than 20 settlements of gas left), `tx-reverted`, `tx-dropped`, `lease-lost`.

## Setup, in order

1. Create the key: `export BW_SESSION=$(bw unlock --raw)` then `scripts/keeper-key.sh`. It saves the key to
   Bitwarden and prints only the address.
2. Send that address a little testnet MON.
3. In `wrangler.toml` `[vars]`, set `KEEPER_ADDRESS` to it and `ROUNDS_ADDRESS` to the deployed MakoRoundsV1.
4. In Healthchecks, create a check with period 1 minute and grace 10 minutes.
5. `wrangler login`, then from this directory `scripts/keeper-secrets.sh` (puts the four secrets).
6. `pnpm deploy`. It runs as a dry run: watch `pnpm tail` for `dry-run-would-send`.
7. Only when Joshua says so: set `DRY_RUN = "false"` and deploy again.

## Development

```
corepack pnpm@10.32.1 install --ignore-workspace
pnpm typecheck && pnpm test && pnpm bundle
```

Tests run in workerd with the real Durable Object and a fake chain and API; nothing leaves the machine.
