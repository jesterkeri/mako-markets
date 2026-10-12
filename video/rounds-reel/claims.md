# Mako Market Rounds film: claims and copy sources

Film: `mako-rounds-1080p60.mp4` (30 s). Fact numbers refer to the eight facts in the approved brief:

1. 15-minute BTC up or down rounds. Pick UP or DOWN before the round starts; when the 15 minutes end, the side that called the move splits the pot.
2. Entries close 60 seconds before the round starts. Minimum entry 0.10 USDC. One side per account.
3. Start and end prices come from Chainlink for the exact second the round starts and ends, checked on-chain. Nobody at Mako Market picks the price.
4. Winners split the pot after 1% to Mako Market and 2% of the smaller side to the round's host.
5. If only one side has stakes, or it is a tie, everyone gets their full stake back, no fee (the app shows "Refund").
6. Sign in with just an email; gas is covered, so no MON is needed to play.
7. New rounds open every 2 hours. It runs on Monad testnet with free test USDC (the app links Circle's faucet), so trying it costs nothing.
8. Live now at makomarket.xyz/rounds (from the user's brief).

## Factual claims on screen

| Shot | On-screen claim | Source |
|---|---|---|
| 1a to 1d | "Think BTC goes up in the next 15 minutes? Call it." | Fact 1 (15-minute BTC up or down rounds) |
| 1c | "15 MINUTES" | Fact 1 |
| 2c | "Pick UP or DOWN. Before the round starts." | Fact 1 |
| 3a | 0.10 chip selected, field reads 0.10 USDC | Fact 2 (minimum entry 0.10 USDC) |
| 3b | "From 0.10 USDC." | Fact 2 |
| 3c | "One side per account." | Fact 2 |
| 3c | "Predictions close 60 seconds before the start." | Fact 2 |
| 4b | "15:00", "ONE ROUND · 15 MINUTES" | Fact 1 |
| 4c | "15 minutes. Up or down?" | Fact 1 |
| 4a, 3c, 2a | "The starting price is taken at 05:00:00 PM." | Fact 3 (price at the exact start second); real app copy, see below. The time is the illustrative round time from the brief |
| 5a | "SOURCE CHAINLINK", "CHECK ON-CHAIN" | Fact 3 |
| 5a, 5b | "START 05:00:00 PM", "CLOSE 05:15:00 PM" | Fact 3 (exact start and end second) with the illustrative round times; a 15-minute round per Fact 1 |
| 5b | "Prices come from Chainlink. The exact start and end second, checked on-chain." | Fact 3 |
| 5b | "Chainlink · verified" tags on START and CLOSE | Fact 3 (checked on-chain) |
| 5c | "Nobody at Mako Market picks the price." | Fact 3 |
| 6a | "WON" on the UP side, DOWN dimmed | Fact 1 (the side that called it wins); illustrative settled state, no amounts |
| 6b | "The side that called it splits the pot." | Fact 1 and Fact 4 |
| 6c | "1% to Mako Market. 2% of the smaller side to the round's host." | Fact 4 |
| 6c | Card label "FEES · TAKEN WHEN A ROUND SETTLES" | Fact 4; the app's claim note says "Fees were taken when the round settled" (src/app/rounds/[id]/RoundClient.tsx, claimSpec) |
| 6a | "Final pots, set when predictions closed. 1% to Mako Market. 2% of the smaller side to the round's host." | First sentence: app copy (RoundClient.tsx, Pots); fee sentence: Fact 4 |
| 7a | Card "Result: Refund" and "Only one side came in, so everyone gets their stake back." | Fact 5; real app copy, see below |
| 7a | "One side only, or a tie?" | Fact 5 |
| 7b | "Everyone gets their full stake back. No fee." | Fact 5 |
| 8a | "Sign in with email. No MON needed." | Fact 6 |
| 8b | "Gas covered" | Fact 6 |
| 8b | "Free test USDC", "Monad testnet" | Fact 7 |
| 8c | "Live now: makomarket.xyz/rounds" | Fact 8 |
| 8c | "New rounds every 2 hours." | Fact 7 |

Not claimed anywhere: prices, balances, pot sizes, payouts, odds or player counts. Pot bars are illustrative splits with no labels and the chart has no price axis. Numbers on screen are limited to 15:00 and the countdown (14:56 to 14:49 as the film clock runs), 0.10, the stake chips (0.10, 1, 5, 10, 25, 50), the default stake 5, 60 seconds, 1%, 2%, 2 hours, and the round times (05:00 PM, 05:15 PM, 05:00:00 PM, 05:15:00 PM, 11:00 AM, 11:15 AM, Round #1).

## UI copy taken from the real app

All paths are in the Mako Market codebase (`/home/user/mako-markets`), read only.

| Copy in the film | Shots | Where it comes from |
|---|---|---|
| Nav "Pools, Rounds, News, Leaderboard, Me", wordmark "Mako Market", "BETA" tag, "Sign in" button | 2a, 3c, 4a, 4c | src/lib/shell-nav.ts (NAV), src/components/shell/DesktopHeader.tsx, src/components/shell/BetaTag.tsx |
| "ROUND · BTC/USD · 05:00 PM to 05:15 PM" | 2a | RoundClient.tsx RoundView header line (the round number is left out) |
| "BTC up or down by 05:15 PM?" | 2a, 4a, 4c | RoundClient.tsx RoundView title format "{symbol} up or down by {close time}?" |
| "Predictions close in" + countdown | 2a, 3c | RoundClient.tsx countdown(), phase "open" |
| "The starting price is taken at 05:00:00 PM." | 2a, 3c, 4a | RoundClient.tsx countdown(), phase "open" sub-line (also used as the chart note in 4a and 4c) |
| "COMMENTARY Nobody has picked a side yet. Predictions close in 14:5x." | 2a, 3c (out of focus) | src/lib/rounds-model.ts commentary() and RoundClient.tsx commentary bar ("0 players in." left out) |
| "BTC/USD", timeframe pills "1M 15M 1H" | 2a, 4a | src/components/MarketChart.tsx |
| "The anchor and close prices are set by Chainlink, the second the round starts and ends." | 4a, 6a | RoundClient.tsx, under the chart |
| "↑ UP", "DOWN ↓", "Odds change until predictions close. Winners split the pot in proportion to their stake, after 1% to Mako Market and 2% of the smaller side to the house." | 2a, 4a (out of focus) | RoundClient.tsx Pots |
| "Make a prediction", "MIN 0.10 USDC", "↑ UP / ↓ DOWN" toggle, stake field with "USDC", chips "0.10 1 5 10 25 50", "Sign in to predict" | 2a, 2b, 3a, 3c | RoundClient.tsx EnterForm (CHIPS constant, default amount "5") |
| "Result", "UP", "Settled on chain from two signed Chainlink prices.", "WON", "Final pots, set when predictions closed." | 6a | RoundClient.tsx countdown() phase "settled" and Pots |
| "REFUNDED" pill | 7a | The user's screenshot of round #1; pill styled like RoundsClient.tsx RoundRow (phase label "Refunded", grey pill) |
| "BTC up or down by 11:15 AM?", "Round #1 · 11:00 AM to 11:15 AM" | 7a | The user's screenshot of round #1 |
| "Result" / "Refund" | 7a | RoundClient.tsx countdown(), phase "refunded" ({ label: 'Result', value: 'Refund' }) and the user's screenshot |
| "Only one side came in, so everyone gets their stake back." | 7a | rounds-model.ts commentary(), refunded / OneSided, and the user's screenshot |
| "Sign in or create an account" | 8a | src/components/signin/SignInDialog.tsx EmailStep title (desktop) |
| "You get a one-time code. No password." | 8a | SignInDialog.tsx EmailStep hint |
| "Email" label, "you@email.com" | 8a | SignInDialog.tsx EmailStep input aria-label and placeholder |
| "Continue" | 8a | Per the brief. The app's email step button reads "Email me a code"; "Continue" is the app's label on a later sign-in step |
| "Free test USDC" | 8b | SignInDialog.tsx perk "Free test USDC" ("From Circle's faucet, to try it on Monad testnet.") |
| "Gas covered" | 8b | Brief wording; the app's perk reads "Gas is paid for you" (SignInDialog.tsx) |

## Film-only text (not product claims)

- Showreel chrome: "MAKO MARKET · ROUNDS", chapter labels ("01 · HOOK" to "08 · START"), timecode, "120 BPM · NN / 08", "1920x1080 · 60P".
- HUD and labels: "PRICE FEED", "DEPTH", "ONE ROUND · 15 MINUTES", "↑ UP · WON", "DOWN ↓", "LIVE NOW", "Chainlink · verified".
- 6a commentary line "The round is settled." is a film placeholder (out of focus), because the app's settled commentary contains prices.
