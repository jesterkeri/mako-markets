# mako-rounds-scheduler

Keeps Mako Market's own BTC rounds on the calendar (Joshua, 2026-10-06): **one round every 2 hours**, on whole
2-hour marks in UTC, two house creators alternating (MakoRoundsV1 lets a creator hold one unfinished round at a
time). Every 5 minutes it reads the contract and, for the next two upcoming slots, has the slot's house call
`schedule` if that slot has no round yet. Each slot is scheduled as soon as its house is free, so predictions stay
open for hours and pots build.

It holds only the two house creator keys. It never enters, settles, refunds or moves USDC; the settlement keeper
settles the rounds, and the contract re-checks every rule (creator list, one unfinished round per creator, the
global cap, 10 minutes to 7 days ahead, whole minutes), so a mistake here can at worst waste gas on a refusal.
It simulates before sending and waits for the receipt, so a later run never sends a duplicate. A Durable Object
lease (`src/state.ts`) lets only one run at a time read, plan and send, so overlapping cron runs cannot both send;
a run that crashes frees it after 4 minutes, and a run sends nothing more than 3 minutes after taking it.

## Setup, in order

1. Create the two house keys: `export BW_SESSION=$(bw unlock --raw)` then `scripts/house-keys.sh`. It saves each
   key to Bitwarden and prints only the addresses. Both addresses go on the creator list at deployment.
2. Send each address a little testnet MON.
3. After MakoRoundsV1 is deployed: in `wrangler.toml` `[vars]` set `ROUNDS_ADDRESS`, `HOUSE_1_ADDRESS` and
   `HOUSE_2_ADDRESS`.
4. `wrangler login`, then from this directory `scripts/scheduler-secrets.sh` (puts the two keys).
5. `pnpm deploy`. It runs as a dry run (`DRY_RUN = "true"`): watch `pnpm tail` for the planned slots.
6. Only when Joshua says so: set `DRY_RUN = "false"` and deploy again.

`INTERVAL_S` changes the cadence (any whole number of minutes) with no code change.

## Development

```
corepack pnpm@10.32.1 install --ignore-workspace
pnpm typecheck && pnpm test && pnpm bundle
```

`pnpm test` runs the Node tests and, in workerd, the lease's Durable Object (`vitest.workers.config.ts`).
`test/*.e2e.test.ts` run the scheduler against the real contract bytecode on a local fork of Monad testnet, two
overlapping runs included; their headers have the commands. They are skipped unless their variables are set.
