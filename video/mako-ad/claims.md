# On-screen claims and their sources

| Claim | Source |
|---|---|
| Short-form prediction markets on Monad | `src/app/layout.tsx:16` (site description) |
| Bet YES or NO on crypto, sport, forex, commodities and stocks. Open for hours to days. | `src/app/pools/PoolsClient.tsx:119` |
| Crypto, Football, NBA, Forex, Commodities, Stocks | Pool data sources: CoinGecko, football-data.org, balldontlie and Pyth. Creating forex, commodities and stocks pools is "coming soon", so the film only claims you can bet on them. |
| YES or NO on anything | `src/lib/tour.ts:83` |
| Your email is your account. No seed phrase. | `src/components/SignInDialog.tsx:385` |
| Gas is paid for you. A bet costs only what you stake. | `SignInDialog.tsx:386`. Email accounts: up to 10 gas-free actions a day (`legal-copy.ts:70`). |
| Free test USDC | `SignInDialog.tsx:387`; Circle faucet (`src/lib/list-states.ts:26-29`) |
| Bet in seconds. | `SignInDialog.tsx:377` |
| From 0.10 USDC, chips 0.10 / 1 / 5 / 10 / 25 / 50 | Minimum bet 0.10 USDC (`legal-copy.ts:86`); bet panel chips |
| Confirm · 0.10 USDC | Bet confirm label (`confirmLabel: Confirm · ${amt} USDC`) |
| Settled on-chain. | `SignInDialog.tsx:382` ("YES/NO pools, settled on-chain") |
| Winners split the pool. | Parimutuel YES/NO pools (`legal-copy.ts`) |
| 1% Mako Market, 2% host | `legal-copy.ts:82` |
| Claim your payout. No deadline. | `legal-copy.ts:78` (claimed by the user, no claim deadline) |
| One side only? Full refund. No fee on refunds. | `legal-copy.ts:78,82` |
| Host your own. Market / Timing and source / Review / Live. Your pool is live | `tour.ts:96`; `CreatePoolClient.tsx:348,635` |
| Hosts earn up to 2%. | `legal-copy.ts:82`. The creator's 2% goes to winners if the smaller side is under about 4% of the larger, so the film says "up to". |
| New: Rounds. 15 min. UP or DOWN. Prices from Chainlink. | `tour.ts:67`. The user confirmed Rounds is live; the legal and tour copy on this branch still says "coming". |
| Climb the board. | `tour.ts:109`. Ranks only, no names or scores. |
| Share any pool. X / WhatsApp / Telegram | `src/components/PoolShareSheet.tsx:83-86` |
| Free test USDC. Monad testnet. | `legal-copy.ts:59`; `src/lib/chain.ts` |

Sample pool questions on the phone screens ("Will Bitcoin close the week higher?", "Will Arsenal beat Chelsea on Saturday?" and similar) are illustrative. They carry no odds, pots, balances or counts.
