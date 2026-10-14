# mako-rounds-watch

The independent alarm for rounds (TASKS T2.0d, INVARIANTS N21). Every 5 minutes it reads MakoRoundsV1 and
tells Joshua, once per round:

- a two-sided round still **unsettled 30 minutes after close**;
- a round that **refunded NoPrice**;

and, for each, what the Data Streams API returned for **both** of the round's seconds, with the time it
asked. For a round still unsettled, both present says only that the API returned them: the watch does not
verify them on chain or simulate a settlement, so the alert points at the keeper and CRE first and the verifier
configuration second; one missing means it cannot settle unless the report appears. For a NoPrice refund the alert states only what the API returned at the check: a check made
after the refund cannot say why the refund happened.

**How it finds rounds.** Every active round is re-read each run (the contract caps non-terminal rounds at
10; past 40 the reads rotate, and none is dropped). A history cursor reads new round ids and always moves
forward, so a round left open for days never hides a newer one. A NoPrice refund goes into a queue once seen
and stays there until Telegram confirms its alert: a refunded round never changes, so it is not re-read.
Report checks are kept per round and rotate (never checked first, then the oldest), so every alerting round
gets its check within a few runs even while Telegram is down. Healthchecks stores 100,000 bytes per ping, so
the failure body is a capped summary plus a page of whole alert lines that rotates from ping to ping: every
line reaches Healthchecks within a few pings however large the backlog. The page moves on only after
Healthchecks accepts it (HTTP 2xx, body "OK"); a timeout, 429 or 5xx sends the same page again next run.

A one-sided round is not flagged: it never settles by design and refunds OneSided.

It holds no wallet key and sends nothing on-chain. It is separate from the keeper so it fails independently
of it, and from the V4 watchdog, which by design holds no credentials and signs nothing.

**Delivery.** Telegram (the watchdog's bot); an alert counts as said only when Telegram confirms it, and is
retried every run until then. Healthchecks is the independent path: `/fail` while any round is in an alert
condition or Telegram failed (the body carries the alert), `ok` otherwise; a watch that stops running is
caught by missing pings. An RPC outage sends no ping, so a lasting one shows up as missing pings.

## Setup

1. In Healthchecks, create a check: period 5 minutes, grace 15 minutes.
2. `wrangler login`, then from this directory: `scripts/watch-secrets.sh` (Data Streams + Healthchecks),
   and the Telegram token and chat id with `mako-design/scripts/bw-secret-to-worker.sh` (see the script's header).
3. Set `ROUNDS_ADDRESS` in `wrangler.toml` `[vars]` once the contract is deployed, then `pnpm deploy`.

## Development

```
corepack pnpm@10.32.1 install --ignore-workspace
pnpm typecheck && pnpm test && pnpm bundle
```
