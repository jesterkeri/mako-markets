# Mako Market indexer (Envio HyperIndex)

Indexes Mako Market's pools contract, `MakoMarketsV4` at `0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195` on Monad
testnet (chain 10143), from its deployment block 32603678, using [Envio HyperIndex](https://docs.envio.dev) over
HyperSync (`https://10143.hypersync.xyz`). Today one feature of the site reads it: the public `/stats` page ("proof
of demand"). The leaderboard, public profiles and search are planned to read it next; until that work ships, the
leaderboard still reads the site's own database.

## What it records

| Entity | One row per | Kept up to date by |
|---|---|---|
| `Pool` | market: question, category, close time, YES/NO totals, distinct bettors per side, status, claims, creator fee | every event of that market |
| `Bet`, `Claim` | `BetPlaced` / `Claimed` event, with its transaction hash | the event |
| `Position` | wallet in a pool: staked YES, staked NO, claimed | bets and claims |
| `Wallet` | address that bet or created a pool: staked, claimed, creator fees, `net` (claimed + fees - staked; note the leaderboard's profit is claimed - staked, without fees), first and last seen | every event it takes part in |
| `DailyStats` | UTC day: new and active wallets, bets, volume, pools created, claims, cumulative wallets | the day's events |
| `CategoryStats` | category: pools, bets, volume | creations and bets |
| `GlobalStats` | one row, `global`: running totals since deployment | every event |

Envio Cloud does not serve aggregate queries, so every total is derived in the handlers
(`src/handlers/MakoMarketsV4.ts`). Amounts are USDC base units (6 decimals); times are Unix seconds.

**Mako Market's own wallets** (the contract's owner, resolver and treasury, plus test accounts, listed in
`src/internal-wallets.ts`) are indexed like any other but left out of every public figure: `DailyStats`,
`CategoryStats`, and the public fields of `GlobalStats` (`communityPools`, `communityPoolsSettled`,
`communityPoolsRefunded`, wallets, bets, volume, claims). `GlobalStats.pools`, `poolsSettled` and `poolsRefunded`
count every pool, Mako Market's own included, for the operator; the public `/stats` never asks for them. `/stats` is
counts only: it never requests or shows a wallet, a transaction or an individual bet or claim.

## Run it

Requirements: Node 22+, pnpm 10, Docker (for `dev`), and a free Envio API token from
[envio.dev/app/api-tokens](https://envio.dev/app/api-tokens) in `indexer/.env` as `ENVIO_API_TOKEN=...`
(never committed; see `.env.example`).

```bash
cd indexer
pnpm install --ignore-workspace
pnpm codegen        # after any change to config.yaml or schema.graphql
pnpm exec tsc --noEmit
pnpm test           # handler tests over simulated events (no network)
pnpm dev            # local Postgres + Hasura via Docker; GraphQL console at http://localhost:8080
```

## Deploy

Envio Cloud deploys from GitHub (the "Envio Deployments" app): this repository, root directory `indexer`, config
`config.yaml`, on the chosen branch. The site reads the deployment's GraphQL endpoint
(`https://<endpoint>/v1/graphql`) through its own `/api/stats` route, which caches the figures.
