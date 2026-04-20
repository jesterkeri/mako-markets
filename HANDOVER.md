# Handover — resuming Mako Markets on Windows

Last session: 2026-04-20 on Mac. This doc captures where we left off so a
fresh Claude Code session on Windows can pick up without replaying context.

**First instruction for the new session:** read this file top to bottom,
then read `MEMORY.md` in your auto-memory directory, then summarise what's
done vs pending before taking any action.

---

## 1. Security incident — status: contained

The old admin wallet was drained on Ethereum mainnet via an EIP-7702
delegation attack. Root cause: the raw private key ended up in a Codex
CLI log file (`~/.codex/log/codex-tui.log`) because an inline command
passed the key as a literal argument. An attacker exfiltrated the key
from that log and used it to sign a Type 4 tx 20 hours later, delegating
the EOA to a MetaMask-flagged phishing contract and draining ETH.

**The leak was NOT from the repo.** No secrets were ever committed, no
`.env` files were tracked, no private keys landed in shell history. The
attack surface was an AI-tool log.

### Wallets in play

| Role | Address | Status |
|---|---|---|
| Old / compromised | `0x774f7559E8fa4EAca55490df4F2F138D53323B9f` | Drained on mainnet. Inert for Mako (contract no longer trusts it). |
| New Mako admin | `0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1` | Clean. Holds 3.88 MON. Owns MakoMarkets contract. |

### What's been done

| Done | What |
|---|---|
| ✅ | On-chain rotation: `owner`, `resolver`, `treasury` = new wallet |
| ✅ | 3.88 MON swept from old to new wallet on Monad |
| ✅ | `ADMIN_ADDRESS` constant in `src/lib/admin-address.ts` → new wallet |
| ✅ | Committed and pushed to `v3-ship` |
| ✅ | `ADMIN_SESSION_SECRET` rotated on Vercel prod |
| ✅ | Codex log truncated (`~/.codex/log/codex-tui.log`) |
| ✅ | 5 Claude Code / Codex transcripts redacted of the old key |

### What's still left

| # | Task | Who | Notes |
|---|---|---|---|
| 1 | ff-merge `v3-ship` → `main` | Claude on request | Prod will update in ~60s. Closes the window where compromised wallet could still sign in to admin dashboard (they can't do anything harmful with access, but best closed). |
| 2 | Replace `ADMIN_PRIVATE_KEY` in `mako-markets/.env.local` | User (in editor, never in chat) | Use new wallet's private key. Currently still holds the compromised value, inert for contract but breaks auto-resolver / seed scripts. |
| 3 | Replace `PRIVATE_KEY` in `mako-contracts/.env` | User (in editor) | Same deal, needed for Foundry deploy scripts. |
| 4 | Update `ADMIN_PRIVATE_KEY` on Vercel prod | Claude via `printf ... \| vercel env add` after user edits `.env.local` | Stdin-piped, never hits argv or logs. |
| 5 | Test admin sign-in on `makomarket.xyz/admin` with new wallet | User in browser | Should work once #1 lands. |
| 6 | (Low priority) Sweep Krait + Cuttlefish for wallet dependencies | Deferred | Those projects use a separate 0G compute key, not the drained EVM key. Different risk, rotate separately if concerned. |

---

## 2. Key files and context for the new session

### Migration artefacts
- `scripts/rotate-admin.mts` — runs the 5-step admin rotation + MON sweep. Idempotent-checked (refuses to run if signer isn't owner). Supports `--dry` flag.
- `scripts/april16-scan.mjs` — forensic scan used to confirm no Mako-side MON transfers on 2026-04-16 UTC (the compromise date).
- `MakoMarkets.dune.abi.json` — ABI extracted for Dune submission. Paste-ready for `dune.com/contracts/new`.
- `WHITEPAPER.md` + `WHITEPAPER.pdf` — v1 whitepaper, already generated.

### Environment variables (live on Vercel prod as of handover)

| Var | Purpose |
|---|---|
| `ADMIN_PRIVATE_KEY` | Auto-resolver signer. **Currently holds the compromised key.** Rotate next. |
| `ADMIN_SESSION_SECRET` | HMAC key for admin session cookies. Rotated 2h before handover. |
| `MONAD_RPC_URL` | Private RPC for higher `getLogs` throughput. |
| `NEXT_PUBLIC_MAKO_ADDRESS` | `0x9d4d399D2fca1432337C5e606D005DEfa2EB4992` |
| `NEXT_PUBLIC_PROJECT_ID` | WalletConnect project ID |
| `FOOTBALL_DATA_API_KEY` / `BALLDONTLIE_API_KEY` / `NEWS_API_KEY` | Data source API keys |

**Note**: only Production environment has these set. Preview env is empty,
which is why admin sign-in on preview URLs currently fails with
`NONCE_FAILED`. Either mirror the secrets to Preview (not recommended)
or just test on prod after #1 lands (recommended).

### Dune setup (half-done)
- ABI extracted, ready at `MakoMarkets.dune.abi.json`.
- Project name to use on submission form: `mako_market` (singular, not `mako_markets`).
- Five SQL queries drafted in the last conversation (not saved to disk).
  If resuming Dune work, ask Claude to regenerate — they're short.

---

## 3. Windows setup checklist

### a. Safe transfer methods for the two `.env` files

Neither `.env.local` nor `.env` is in git (correctly gitignored). Pick any one:
- **Vercel env pull** (recommended, cleanest): after cloning on Windows,
  run `vercel env pull .env.local` inside `mako-markets`. Vercel CLI
  authenticates, links the project, and pulls all production env vars.
  No USB needed. You'll still need to manually rotate `ADMIN_PRIVATE_KEY`
  to the new wallet's key later, but that's a separate step from the transfer.
- **1Password / Bitwarden secure note**: paste values on Mac, retrieve on Windows.
- **USB drive**: copy the two files, transfer, paste.

### b. Boot-up sequence on Windows

```powershell
# 1. Clone repos (somewhere sane, e.g., C:\Users\<you>\code\mako market\)
git clone https://github.com/jesterkeri/mako-markets.git
git clone https://github.com/jesterkeri/mako-contracts.git
cd "mako-markets"
git checkout v3-ship

# 2. Install deps
pnpm install

# 3. Restore env
vercel env pull .env.local    # or copy from 1Password / USB

# 4. Restore mako-contracts env
cd ..\mako-contracts
# paste the two lines into .env:
#   PRIVATE_KEY=0x<new wallet's private key>
#   TREASURY=0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1

# 5. First, start Claude Code once in mako-markets to create the projects folder:
cd ..\mako-markets
claude
# exit immediately with Ctrl+D once it starts — we just need the folder created
```

### c. Restore Claude memory (after step 5 above)

Memory lives at `~/.claude/projects/-Users-joshuazekeri-code/memory/` on Mac.
On Windows, the equivalent path uses Windows-style path encoding.

```powershell
# Find the newly-created projects folder:
dir $env:USERPROFILE\.claude\projects

# You'll see a folder name derived from your Windows code path,
# e.g., "C--Users-Joshua-code". The Mac zip uses the folder name
# "-Users-joshuazekeri-code", so move the memory files (not the whole
# folder structure) into the Windows-named folder's memory/ subdir.

# Extract the zip into the correct place manually or with:
Expand-Archive -Path "$env:USERPROFILE\Desktop\claude-memory-backup.zip" -DestinationPath "$env:USERPROFILE\claude-memory-tmp"
# Then copy the contents of .\claude-memory-tmp\-Users-joshuazekeri-code\memory\
# into $env:USERPROFILE\.claude\projects\<your-windows-folder-name>\memory\
```

### d. First prompt on Windows

```powershell
cd "C:\Users\<you>\code\mako market\mako-markets"
claude
```

Then type exactly:

```
read HANDOVER.md and tell me where we left off before we continue.
```

The new session will read this file, summarise status, and resume from
"ff-merge v3-ship → main" (or whatever the current step is per Section 6).

### e. Quick sanity tips for Windows

- **Monad RPC URL**: the one in `.env.local` from `vercel env pull` is the
  private RPC that allows 1000-block `getLogs` windows. Don't replace it
  with the public `testnet-rpc.monad.xyz` fallback unless you like slow scans.
- **Port**: `pnpm dev` runs on `localhost:3000` by default on Windows
  (was 3001 on Mac). Either works. Just update any hardcoded `3001`
  references if you run into them (there aren't any in the repo today).
- **If tsx can't find `viem`**: re-run `pnpm install`. Windows sometimes
  needs a fresh lockfile install after transfer.
- **Path with space (`mako market`) works on Windows** but causes the
  usual quoting gotchas. If it annoys you, rename to `mako-market`
  (no scripts hardcode the path, safe rename).
- **Watch out for line endings**: if you edit `.env` on Windows with
  CRLF and it gets confused, re-save as LF. Most modern editors default
  to LF now.

---

## 4. Key protection going forward

Hard rules learned from this incident:

1. **Never inline a private key into a shell command** — not as argv,
   not as heredoc, not in a `node -e "..."` snippet. Always read via
   `process.env.FOO` inside the script.
2. **Turn off Codex telemetry** or don't use Codex on repos with live
   secrets. Run `codex config set telemetry off` (or equivalent).
3. **Audit leak surfaces monthly**: grep `~/.codex ~/.claude` for
   64-hex patterns; silence is the expected result.
4. **Consider a hardware wallet** (Ledger / GridPlus) for any admin role
   that controls real funds. For testnets, software wallet + discipline
   is fine.
5. **Key-per-project**: never reuse a single EOA across Mako / Krait /
   Cuttlefish / whatever else.
6. **Hot / cold split**: the wallet that runs the auto-resolver should
   NOT be the wallet that owns the contract. Two wallets, two risk profiles.

---

## 5. Current branch state

Check with `git log --oneline main..v3-ship` from inside `mako-markets`. As
of this handover, `v3-ship` is 3 commits ahead of `main`:
- `chore(brand): rename "Mako Markets" to "Mako Market"` (shipped)
- `security(admin): rotate ADMIN_ADDRESS to fresh admin wallet` (shipped)
- `chore: commit migration scripts, whitepaper, dune abi, and handover` (shipped)

`mako-contracts` is on `main`, up to date.

---

## 6. Detailed plan of action

This section is the playbook for the next Claude session. Read it once,
then work through the steps in order. Each step has: **what**, **why**,
**how** (exact commands), **expected outcome**, and **recovery** notes.

### Step 1 — ff-merge `v3-ship` → `main`

**What:** Fast-forward `main` to the head of `v3-ship` and push, so
`makomarket.xyz` redeploys with the updated `ADMIN_ADDRESS` constant.

**Why:** Prod is still serving the 1-day-old build where `ADMIN_ADDRESS`
is the compromised wallet (`0x774f…3B9f`). The attacker holding the
stolen key could technically still sign in to the admin dashboard today.
They cannot execute any privileged on-chain action because the contract
no longer recognises that wallet as resolver/owner/treasury, but the
read-only access is a window worth closing.

**How:**
```
cd mako-markets
git fetch origin
git checkout main
git merge --ff-only v3-ship
git push origin main
```

**Expected outcome:** GitHub shows `main` at the same commit as `v3-ship`.
Vercel auto-triggers a production deploy; it's usually Ready in 45–90s.
Check: `vercel ls --prod | head` — the top row age column should show
seconds or a minute or two.

**Recovery if the merge is not fast-forward:** that means someone pushed
to `main` directly (unlikely given the workflow). Investigate with
`git log main..origin/main`. Don't force-push. Rebase `v3-ship` on
`main`, resolve conflicts, re-push `v3-ship`, retry the merge.

**Recovery if Vercel build fails:** look at build logs with
`vercel logs --follow`. Most likely cause: missing env var in
Production. Compare against `.env.local.example`.

**Verification after prod is Ready:**
1. Visit `https://makomarket.xyz/admin` in a clean browser tab.
2. MetaMask connects; account selector shows the new wallet
   (`0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1`).
3. Click `SIGN IN AS ADMIN`. MetaMask prompts a SIWE signature. Sign.
4. Dashboard unlocks; stats tiles render. If instead it throws
   `NONCE_FAILED` or `UNAUTHORIZED`, see troubleshooting below.

---

### Step 2 — Replace compromised key in `mako-markets/.env.local`

**What:** Replace the `ADMIN_PRIVATE_KEY=0x774f…` line with the new
wallet's private key.

**Why:** The compromised key is inert against the contract (not trusted
anymore) but it is still the value that local scripts (auto-resolver,
seed-\*, rotate-admin dry-runs) will try to sign with. Until replaced:
local `pnpm run auto-resolver` will 500; `pnpm run seed` will 500;
any local admin tooling against Monad will attempt a signature from
a wallet the contract ignores, and those txs will revert.

**How:** Open `mako-markets/.env.local` in your editor (VS Code,
nano, whatever). Find:
```
ADMIN_PRIVATE_KEY=0x774f...
```
Change the value to the new wallet's private key. Save. Do not paste
the key into chat, terminal, or any shell command.

**Expected outcome:** File saved, one line changed. Nothing runs yet.

**Verification (this uses env-only access, never prints the key):**
```
cd mako-markets
set -a; source .env.local; set +a
node -e 'import("viem/accounts").then(({privateKeyToAccount}) => console.log(privateKeyToAccount(process.env.ADMIN_PRIVATE_KEY).address))'
```
Should print `0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1`. If it prints
anything else, the value you pasted is wrong — re-copy from your secure
store. If it throws "invalid private key", check for missing `0x`
prefix or extra whitespace.

**Recovery:** if the file is botched, the auto-resolver won't run.
Low blast radius. Re-edit, re-verify.

---

### Step 3 — Replace compromised key in `mako-contracts/.env`

**What:** Same as Step 2, but for the Foundry deploy / script env.

**Why:** Foundry's `Deploy.s.sol` script reads `PRIVATE_KEY` via
`vm.envUint("PRIVATE_KEY")`. If you ever redeploy the contract or run
other `forge script` calls, they sign with this key.

**How:** Edit `mako-contracts/.env`. Find:
```
PRIVATE_KEY=0x774f...
```
Replace with the new wallet's private key. Optionally also set:
```
TREASURY=0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1
```

**Verification:**
```
cd mako-contracts
source .env
cast wallet address --private-key "$PRIVATE_KEY"
```
Should print the new address. Never print the key itself.

---

### Step 4 — Rotate `ADMIN_PRIVATE_KEY` on Vercel production

**What:** Remove the compromised key from Vercel prod env and replace it
with the new one.

**Why:** Any future Vercel Cron-based auto-resolver, or any server-side
admin operation running in production, would use this value. Leaving it
as the compromised key means those flows are broken on prod (same reason
as step 2).

**How:** Must be done after step 2 (the new key needs to exist in
`.env.local` so Claude can pipe it via `process.env` without it ever
appearing in a shell argument).

```
cd mako-markets
set -a; source .env.local; set +a

# Remove the old value from Vercel
vercel env rm ADMIN_PRIVATE_KEY production --yes

# Add the new value via stdin pipe (value never appears in argv)
printf '%s' "$ADMIN_PRIVATE_KEY" | vercel env add ADMIN_PRIVATE_KEY production

# Confirm
vercel env ls production | grep ADMIN_PRIVATE_KEY
```

**Expected outcome:** `vercel env ls` shows `ADMIN_PRIVATE_KEY` created
`0s ago` or `seconds ago` in Production environment.

**Important:** env var changes don't auto-redeploy. To apply the new
value, trigger a redeploy: `vercel --prod` or push an empty commit.

**Recovery:** if the `rm` succeeds but `add` fails, Vercel is now
missing the env var and prod might fail on cold start. Re-run the `add`
command.

---

### Step 5 — End-to-end verification

**What:** Confirm the full migration worked from contract → frontend →
off-chain resolver.

**Steps:**
1. **Contract:**
   ```
   cast call 0x9d4d399D2fca1432337C5e606D005DEfa2EB4992 "owner()(address)" --rpc-url https://testnet-rpc.monad.xyz/
   ```
   Expect: `0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1`.

2. **Frontend admin gate:** sign in at `makomarket.xyz/admin` with the
   new wallet. Dashboard should render.

3. **Auto-resolver (if running locally):**
   ```
   cd mako-markets
   pnpm run auto-resolver
   ```
   Should start polling without errors. If it prints "not owner or
   resolver" errors, the .env key isn't the new one.

4. **Seed scripts (optional sanity):**
   ```
   pnpm run seed -- --dry
   ```
   Should derive address `0xC8BF…` without erroring.

---

## 7. Follow-up work, prioritised

### Near-term (same session or next)

- **Set up Dune dashboard.** Half done. We extracted the ABI
  (`MakoMarkets.dune.abi.json`) and drafted the submission form values.
  Remaining: submit at `dune.com/contracts/new` (project name
  `mako_market`, singular), wait for decoding (~hours), paste the
  five queries (need to re-draft from conversation memory — they query
  `monad_testnet.mako_market_evt_BetPlaced` and friends), build the
  dashboard layout. Full spec lives in the previous conversation; ask
  Claude to regenerate the 5 queries if resuming.

- **Purge current-session transcript.** This very file
  (`~/.claude/projects/.../e0a8e8dd-f868-44e2-a23b-bc913154ba3b.jsonl`)
  still contains the old compromised key from conversation outputs.
  Once the session ends, redact it:
  ```
  node -e '
    const fs = require("fs");
    const old = "<the-old-compromised-key-hex>";
    for (const f of ["<path-to-jsonl>"]) {
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replaceAll(old, "<REDACTED>"));
    }
  '
  ```

### Medium-term (this week or next)

- **Hardware wallet for the admin role.** Order a Ledger Nano X or
  GridPlus Lattice1. Transfer contract ownership + resolver + treasury
  to the hardware wallet's address (same `rotate-admin.mts` script
  accepts any address). After this, key leaks become impossible for
  admin operations because the key never touches software.

- **Split hot / cold wallets.**
  - **Cold (hardware) wallet:** owns the contract. Rarely signs.
    Only used for `transferOwnership`, `setFees`, rotations.
  - **Hot (software) wallet:** acts as resolver only. Signs
    `resolveMarket()` calls. Its key lives in `.env.local` and on
    Vercel. If this key leaks, the blast radius is "attacker can
    resolve markets with wrong outcomes" — bad but not catastrophic.
    `forceRefund()` is available as a safety net.
  - The contract already supports this via separate `owner` and
    `resolver` fields. It's a one-function-call change via
    `setResolver(0xHOT)`.

- **Move auto-resolver to Vercel Cron** (was previously deferred).
  The Vercel Cron runs the resolver loop on a schedule independent
  of any operator machine. Wire it via a new API route and a
  `vercel.json` cron config. Uses the hot-wallet key.

### Long-term / optional

- **Multi-sig ownership** via Gnosis Safe. Turn the `owner` role into
  a 2-of-3 Safe. Even if one signer's key leaks, the other two reject
  the transfer. Heavier process (every admin change needs co-signers)
  but cuts single-key risk to zero.

- **Secret manager.** Replace `.env.local` files with 1Password CLI
  (`op run -- pnpm dev`) or Doppler. Keys never touch disk.

- **Sweep Krait + Cuttlefish.** Those projects share a 0G compute
  private key (`ZG_COMPUTE_PRIVATE_KEY` / `ZG_PRIVATE_KEY`) that
  wasn't implicated in this drain, but the reuse is bad hygiene.
  Rotate each to a per-project key. Separate effort, not urgent.

---

## 8. Troubleshooting runbook

| Symptom | Likely cause | Fix |
|---|---|---|
| `NONCE_FAILED` on preview admin sign-in | `ADMIN_SESSION_SECRET` not set on Preview env | Skip preview, test on prod (makomarket.xyz/admin) instead. Preview secrets are a separate hygiene task. |
| `UNAUTHORIZED` after SIWE signature | Address mismatch: `ADMIN_ADDRESS` constant doesn't match connected wallet, or signed message has wrong domain/chainId | Check `src/lib/admin-address.ts` constant. Check Monad chain ID 10143 on MetaMask. Clear site cookies and retry. |
| `500` on `/api/admin/analytics` | Missing `ADMIN_SESSION_SECRET` at runtime, or session cookie expired | Re-sign-in. If still 500, check Vercel logs: `vercel logs --follow`. |
| Auto-resolver prints "not owner or resolver" | `.env.local` still has compromised key | Step 2 of the plan. |
| Vercel deploy stuck on "Queued" | Previous build hung | Cancel in Vercel dashboard and redeploy. |
| `cast call` returns garbage / times out | Public Monad RPC rate-limited | Use the private RPC from `.env.local` (`MONAD_RPC_URL`). |

---

## 9. Reference: useful commands on Windows

```powershell
# Check migration state
cast call 0x9d4d399D2fca1432337C5e606D005DEfa2EB4992 "owner()(address)" --rpc-url https://testnet-rpc.monad.xyz/

# Check balances
cast balance 0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1 --rpc-url https://testnet-rpc.monad.xyz/ --ether
cast balance 0x774f7559E8fa4EAca55490df4F2F138D53323B9f --rpc-url https://testnet-rpc.monad.xyz/ --ether

# Pull Vercel env (after updating ADMIN_PRIVATE_KEY via step 4)
vercel env pull .env.local

# Confirm local .env key derives to the expected address
set -a; source .env.local; set +a
node -e 'import("viem/accounts").then(({privateKeyToAccount}) => console.log(privateKeyToAccount(process.env.ADMIN_PRIVATE_KEY).address))'

# Tail prod logs
vercel logs --follow
```

Fast-forward `v3-ship` → `main` is the pending action (#1 above).
