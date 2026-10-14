# Mako Market

A prediction market on Monad where anyone can create a market, and the person who brings the crowd gets paid.

**Live (Monad testnet):** https://makomarket.xyz

## How it works

1. **Pools.** Anyone can open a YES/NO pool on crypto, stocks, forex, commodities or sports. Bets go into a shared pot and winners split it, so there is no house taking the other side. The creator earns 2% of the pot, but only if both sides have real money in it.
2. **Rounds.** 15-minute Up or Down rounds scheduled by Mako Market every two hours, starting with BTC/USD. Entries close when the round starts. Open and close prices come from Chainlink Data Streams, verified on chain. Winners split the pot; a one-sided round, or one with no valid price, refunds everyone.
3. **Settlement you can trust.** Anything not settled within 24 hours of closing is refunded automatically, so money never sits stuck.
4. **No crypto knowledge needed.** Sign in with email (Privy): no wallet to install, no seed phrase, no gas. Every bet, entry and claim from an email account is gas-sponsored (ERC-4337 Safe accounts, Pimlico paymaster).

## Contracts (Monad testnet, chain 10143)

| Contract | Address |
|---|---|
| MakoMarketsV4 (pools) | [`0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195`](https://testnet.monadvision.com/address/0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195) |
| MakoRoundsV1 (rounds) | [`0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921`](https://testnet.monadvision.com/address/0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921) |

Solidity source: [jesterkeri/mako-contracts](https://github.com/jesterkeri/mako-contracts), branches [`feat/t15-deploy-rounds`](https://github.com/jesterkeri/mako-contracts/tree/feat/t15-deploy-rounds) (rounds, Data Streams settlement rule) and [`v4`](https://github.com/jesterkeri/mako-contracts/tree/v4) (pools).

## Where things live

| Part | Path |
|---|---|
| Web app (Next.js) | [`src/`](src) |
| Chainlink CRE workflow that settles rounds from Data Streams | [`cre/`](cre) |
| Envio indexer (`/stats`, rounds in Me) | [`indexer/`](indexer) |
| Pool resolver (Cloudflare Worker) | [`cf-worker/`](cf-worker) |
| Rounds keeper, scheduler and watch (Cloudflare Workers, deployed from their branches) | [`feat/rounds-keeper`](https://github.com/jesterkeri/mako-markets/tree/feat/rounds-keeper), [`feat/rounds-scheduler`](https://github.com/jesterkeri/mako-markets/tree/feat/rounds-scheduler), [`feat/rounds-watch`](https://github.com/jesterkeri/mako-markets/tree/feat/rounds-watch) |

A round settled end to end through the CRE workflow on 2026-10-12: [tx `0x5b3c…8778`](https://testnet.monadvision.com/tx/0x5b3c20601cc89c6bef20b29ee1e54c2e7b4ca0a5372e9f71952b8146791c8778).

## Run locally

```bash
corepack pnpm@10.32.1 install
cp .env.local.example .env.local   # fill in your own values
corepack pnpm@10.32.1 dev
```

Tests: `corepack pnpm@10.32.1 test`.
