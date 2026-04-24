# Mako Markets plans

Tracks the post-hackathon backlog for Mako Markets. The original 7-phase build plan (`makomarketsbuildplan.md`, kept on Mac) shipped at Monad Blitz Lagos on 2026-04-11. Items here came up afterwards, starting with the 2026-04-15 wallet drain and the resulting rotation, secrets migration, and move off GitHub Actions cron.

Read this file before starting work in the repo so fixes don't break planned items.

## Current state (2026-04-21)

- Admin wallet rotated from the drained `0x774f7559E8fa4EAca55490df4F2F138D53323B9f` to `0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1`. Contract `owner`, `resolver`, and `treasury` updated on-chain on Monad testnet.
- Private keys removed from plaintext in `mako-markets/.env.local` and `mako-contracts/.env`. Key is fetched from Bitwarden via `scripts/with-bw.mjs` (Node scripts) or `wrangler secret put` (CF Worker).
- Auto-resolver migrated from GitHub Actions cron (file removed) to Cloudflare Workers at `https://mako-auto-resolver.jesterkeri.workers.dev`, scheduled `*/1 * * * *`. End-to-end verified: markets 22 and 29 resolved on-chain from CF (tx hashes in session history).
- `scripts/auto-resolver.mts` kept for local debugging via `pnpm auto-resolver:bw`.
- `scripts/scan-for-leak.mjs` is available for confirming zero key residue in any directory.

## Backlog

Ordered by priority. Each item has context, concrete steps, and a verify check so the work is unambiguously done.

### 1. Mirror Bitwarden pattern to mako-contracts, Krait, Cuttlefish

**Priority:** High. These repos still read the admin key from plaintext files, so any one of them leaking re-exposes the new rotated wallet the same way the old one got drained.

**Files:**
- `mako-contracts/.env` (currently only has `TREASURY`, but Foundry scripts that read `vm.envUint("PRIVATE_KEY")` will need the wrapper once `PRIVATE_KEY` is no longer in that file)
- Krait repo equivalents (inventory first; the agent pipeline may reference the key in multiple places)
- Cuttlefish repo equivalents (same)

**How:**
1. Copy `mako-markets/scripts/with-bw.mjs` into each project (or generalise it into a shared tool if multiple key identities emerge).
2. Add `with-bw.mjs`-style npm scripts (`forge:bw`, `deploy:bw`, etc) to each project's `package.json`.
3. Remove any plaintext `PRIVATE_KEY=...` lines from `.env` files, commit the cleaned files.
4. Run `node <path-to-mako-markets>/scripts/scan-for-leak.mjs <repo-path>` against each project to confirm zero residue.

**Verify:** Each repo's scan reports 0 hits. Run one Foundry script or equivalent through the wrapper, confirm the tx broadcasts with the expected signer.

### 2. Bitwarden two-factor authentication

**Priority:** High. Bitwarden is now the single point of failure for the rotated key. Without 2FA, a master password leak is equivalent to a key leak.

**How:**
1. Open vault.bitwarden.com, log in.
2. Settings, Security, Two-step Login.
3. Pick an authenticator app (Google Authenticator, Authy, or any TOTP app). Avoid SMS.
4. Scan the QR in the app, save the recovery code somewhere other than Bitwarden itself (paper, password manager on another device, encrypted note on iCloud Keychain).

**Verify:** Log out of the web vault, log back in, confirm the 2FA prompt. Run `bw status` from CLI and confirm the saved session still unlocks.

### 3. Manual "Claim Funds" admin button

**Priority:** Medium. The treasury share accumulates on-chain with no UI path to withdraw it. Joshua prefers a manual claim over an automatic sweep for auditability.

**Files (estimated):**
- Contract: `mako-contracts/src/MakoMarkets.sol`. Confirm `claimTreasury()` or equivalent owner-only function exists; add it if not.
- Frontend: `mako-markets/src/app/admin/` page. Add a card that reads the treasury balance and a button that calls the claim function.
- Resolver: no change. This is a separate admin action, not part of per-market resolution.

**How:**
1. Check the contract ABI for an existing treasury-claim function. If missing, write it, test it, redeploy (triggers a v4 cutover; add a note to memory about the new address).
2. Wire the button using the same wagmi pattern as existing admin actions (`useWriteContract`).
3. Show the treasury balance before and after via `useReadContract`.
4. Gate the button behind the existing SIWE admin auth (same pattern as the rest of `/admin`).

**Verify:** Create a market with a fee, resolve it, confirm treasury balance increases. Click Claim, confirm the tx lands and the balance drops on the next block.

### 4. CF Worker RPC rate-limit optimisation

**Priority:** Low. Current state works (markets resolve within 1 to 3 ticks, 1 to 3 minutes after close). This only matters if market count grows meaningfully past ~30, or if cleaner tail logs become valuable.

**Current workaround:** `cf-worker/src/index.ts` reads markets in chunks of 5 with 500ms pauses, staying under Monad public RPC's ~15 req/sec limit. Per-tick latency is about 3 seconds for 30 markets, invisible at 60s cron cadence.

**Options, pick one:**
- **Multicall3.** If Monad testnet has Multicall3 at `0xca11bde05977b3631167028862be2a173976ca11`, switch to `publicClient.multicall()` so all reads become a single `eth_call`. Needs `contracts.multicall3` added to the `monadTestnet` chain config in the Worker.
- **Paid RPC provider.** Alchemy, QuickNode, or Ankr often have higher rate limits for Monad testnet than the public endpoint. A key would need to live as a CF Worker secret (`wrangler secret put`) rather than a plaintext URL.
- **JSON-RPC array batching.** Verify with a raw curl whether Monad's public RPC actually accepts array-body requests. If it does, `http(url, { batch: { wait: 64 } })` with `Promise.all` across all reads becomes the simplest fix.

**Verify:** After change, a tick with 30 to 100 markets logs zero `getMarket failed` warnings and completes within one cron window. Use the Codex adversarial review prompt from session notes before shipping.

## Not tracked here

- Session cleanup (deleting session JSONL files, clearing tmp dirs). These are habits, not product work.
- Hardware wallet for the owner role. Deferred indefinitely, budget-gated.
- Contract redeploy logistics (v4 and beyond). Handled ad hoc per the deploy checklist in `project_mako_markets.md` memory.
