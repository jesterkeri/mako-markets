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

### a. Clone the repos
```
git clone https://github.com/jesterkeri/mako-markets.git
git clone https://github.com/jesterkeri/mako-contracts.git
```
Pick up on the `v3-ship` branch in `mako-markets`. `mako-contracts` is
on `main` (already up to date).

### b. Restore `.env` files
Neither is in git (correctly gitignored). Safe transfer options, pick one:
- **Vercel env pull** (recommended, cleanest): `vercel env pull .env.local`
  in the `mako-markets` folder. This pulls all prod env vars. Will still
  have the compromised `ADMIN_PRIVATE_KEY` until you rotate it.
- **1Password / Bitwarden secure note**: paste values on Mac, retrieve on Windows.
- **USB drive**: copy the two files, transfer, paste.

For `mako-contracts/.env`, it only needs:
```
PRIVATE_KEY=0x<new wallet's private key>
TREASURY=0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1
```

### c. Restore Claude auto-memory
Memory is at `~/.claude/projects/-Users-joshuazekeri-code/memory/` on Mac.
On Windows, the equivalent path uses Windows-style encoding of your code
directory. Steps:

1. Zip the Mac memory folder: `cd ~/.claude/projects && zip -r memory-backup.zip -Users-joshuazekeri-code/memory/`
2. Transfer the zip to Windows.
3. On Windows, start Claude Code once inside your `code/mako market/mako-markets` folder so it creates the projects dir with the right Windows-path-derived name.
4. Unzip the memory files into that new folder.

### d. First Claude Code session on Windows
```
cd C:\Users\<you>\code\mako market\mako-markets
claude
```
First message: `read HANDOVER.md and continue`

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

- `mako-markets` is on `v3-ship`, 2 commits ahead of main:
  - `chore(brand): rename "Mako Markets" to "Mako Market"` (shipped)
  - `security(admin): rotate ADMIN_ADDRESS to fresh admin wallet` (shipped)
- `mako-contracts` is on `main`, up to date.

Fast-forward `v3-ship` → `main` is the pending action (#1 above).
