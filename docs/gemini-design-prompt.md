# Gemini — design Mako Markets' frontend

You are designing the complete frontend for **Mako Markets**, a short-form prediction market app on Monad. Deliver React + Tailwind v4 components + a visual style sheet. Another agent (Claude) will wire your components into the existing Next.js app.

---

## 1. Read these files before designing anything

All under `C:\Users\hr\Claude Cowork\mako market design file\`:

- `README.md` — brand system, fully locked. Do NOT modify fonts, colors, shapes, shadows, tilts.
- `brand-sheet.html` — visual reference
- `tokens/mako-brand.css` — CSS custom properties + ready-to-use `.mako-*` component classes
- `tokens/mako.theme.ts` — Tailwind theme preset
- `components/Logo.tsx` — Logo component with `mark` / `wordmark` / `lockup` variants
- `mako-brand-system.pdf` — full brand reference
- `logos/` — SVG and PNG assets

Also skim the existing codebase at `C:\Users\hr\My VS code\mako-markets\src\` to see current component structure. **Preserve existing data hooks and component logic** — only redesign visuals and UX.

---

## 2. Product context

**What Mako is:** parimutuel prediction markets on Monad. Users bet USDC on YES/NO outcomes in football, crypto, and basketball markets. Markets are community-created, oracle-resolved.

**Two user types (roughly 50/50 blend):**

- **Web2 users** — sign up with email, get an embedded wallet auto-provisioned via Magic.link, fund with card (MoonPay) or Nigerian bank transfer (Monnify Naira). Never see MON, chain, or gas.
- **Crypto-native users** — click a small hidden footer link, connect MetaMask/Rabby/WalletConnect. Send USDC directly. More friction acceptable for self-custody clarity.

**Hidden chain reality (keep invisible to web2 users):**
- Contract on Monad, bets in USDC (ERC-20)
- Paymaster sponsors all gas — users never need MON
- MoonPay delivers USDC on Base; user signs a CCTP bridge to Monad on next visit

---

## 3. Locked design system (do NOT modify)

**Fonts:**
- Bricolage Grotesque 800 — display, titles, buttons, metrics (tracking -0.02em to -0.03em)
- Inter — body (500), labels (800 with 0.15em tracking, UPPERCASE)
- System mono — reserved for tickers, addresses, columnar numbers only

**Colors:** `paper` `#EBE5D9`, `surface-elevated` `#E1DBCB`, `ink` `#000`, `signal` `#FACC15`, `mako-red` `#D94A3D`, `muted` `#79797A`, `subtle` `#A3A19C`

**Shape language:**
- 2px solid ink borders always
- 12px radius (buttons, tiles), 16px radius (cards)
- Hard shadows `4px 4px 0 0 ink`, no blur, no gradients
- Press animation: active state translates 2px down-right and halves the shadow
- Playful tilts: 2–4° on selected sticker elements

**Bet colors:** YES = `ink` fill + `paper` text. NO = `mako-red` fill + `paper` text.

**Rules:**
- Text on `ink` or `mako-red` = `paper`, never pure white
- `signal` always pairs with ink text
- Don't use `mako-red` + `signal` as primary in the same component — they clash
- Labels: UPPERCASE with 0.15em tracking. Mixed case elsewhere.

---

## 4. Payment state indicators

Every deposit progresses through explicit states. Each state has a distinct visual pill:

| State | Visual |
|---|---|
| `initiated` | subtle gray pill "Started" |
| `paid` | signal-yellow pill "Paid, settling..." |
| `bridging` | signal-yellow pill "Bridging to Monad..." |
| `settled` | no pill — counts as spendable balance |
| `failed` | mako-red pill "Failed" with retry action |
| `refunded` | gray pill "Refunded" |

**Hard invariant:** only `settled` deposits count as spendable balance. UI must NEVER show paid-but-not-settled funds as available to bet. The "spendable" number on the profile page reflects only settled USDC on Monad.

---

## 5. Screens to design

Each screen needs mobile-first layouts + loading, empty, error, and success states.

### New screens

1. **Sign-in / sign-up** — email-first, single screen
   - Big Mako lockup at top
   - Primary: `SIGN IN WITH EMAIL` button (signal) → email input → Magic.link magic-link confirmation
   - Tiny footer link: "I'm a crypto user → Connect Wallet" (opens RainbowKit)
   - Allowlist rejection state: non-allowlisted email shows "You're not invited yet" sticker

2. **Profile `/profile`** — main hub after signup
   - Email + logout at top
   - **Balance** (big Bricolage 800 metric) — SETTLED USDC only. Pending items shown as separate pills below.
   - **Deposit options** (three buttons):
     - `PAY WITH CARD` (signal) → MoonPay modal
     - `PAY WITH NAIRA` (signal, Nigerian users only) → VAN modal
     - `SEND CRYPTO` (ink outline) → crypto deposit modal
   - **Pending bridges** — cards with "Sign bridge" CTA
   - **Recovery / security** — honest copy about email compromise = signer compromise. Export private key button. Instructions for using exported key if Magic ever fails.
   - **Bet history** — positions with claim buttons
   - **Withdraw** — separate card (crypto or Naira)

3. **KYC `/profile/kyc`** — Nigerian-user BVN + selfie
   - Step 1: BVN input
   - Step 2: Selfie capture (Smile Identity SDK — design the wrapper only)
   - Step 3: Verified confirmation
   - Error states: BVN mismatch, liveness failed, retry

4. **Deposit modals** — three distinct widgets:
   - **MoonPay modal** — embedded widget + "Preparing your USDC, 1–5 min" + settled success
   - **Naira VAN modal** — permanent virtual account number with copy and share; instructions for Nigerian bank transfer; pending state "We received your ₦X, crediting now"
   - **Crypto deposit modal** — Safe address (text + QR), chain label "USDC ON MONAD ONLY", warning sticker "Sending from an exchange? Select Monad network"; embedded CCTP widget for Base→Monad; LI.FI widget for other chains

5. **Bridge sign prompt** — full-screen overlay when user returns with pending bridge
   - "Your USDC arrived on Base" headline
   - 2° tilted sticker
   - Single `BRIDGE TO MONAD` button (signal) + "Cancel (do later)" secondary

6. **Admin allowlist `/admin/allowlist`** — new admin page
   - Table of allowlisted emails with remove buttons
   - Add-email form
   - Uses existing SIWE admin auth

### Restyled existing screens (keep data flow, replace visuals)

7. **Home `/`** — market grid with sticky filter tabs (ALL / FOOTBALL / CRYPTO / NBA). Empty state: 3° tilted "No markets here yet" sticker with Create CTA. Loading skeletons matching card dimensions.

8. **Market detail `/market/[id]`** — big question in Bricolage. Live YES/NO tiles using `.mako-bet-tile--yes` and `.mako-bet-tile--no`. Restyled bet sheet (keep math untouched). Claim action for resolved markets. Live badge pulses mako-red when open.

9. **Create market `/create`** — form with 2px borders, 12px radius inputs. Market type as button group. Close-time chips ("1h", "24h", "3d", "7d"). Preview card.

10. **`/me` positions** — ACTIVE / CLOSED tabs. Position cards with inline claim. Empty state.

11. **Admin `/admin/*`** — restyle tables, buttons, forms. Analytics charts re-themed (ink bars on paper, mako-red for negatives). Keep hooks.

### Global components

12. Header — Mako lockup left, filter center, user avatar + balance pill right
13. Sidebar (restyle existing)
14. PriceTicker (restyle — keep marquee)
15. Bottom tab bar (mobile-only)
16. Toast / notification for payment state changes
17. Modal / sheet pattern (consistent for MoonPay, Naira, Crypto modals)

---

## 6. What to remove from the current repo

The existing Mako UI has patterns that should NOT carry over:

1. **Heavy `font-mono` usage** (158 occurrences) — mono is reserved for tickers, addresses, and columnar numbers only. Sweep most to Inter body.
2. **`[ BRACKETED ]` label style** — drop entirely. Use plain UPPERCASE labels with 0.15em tracking.
3. **Dangling `--font-inter` reference in `globals.css`** — fix when wiring Bricolage + Inter via `next/font/local`.
4. **Generic "Connect Wallet" primary CTA** on home — relegate to hidden footer link.
5. **Missing loading skeletons + empty states** — add everywhere.
6. **MON amount displays** ("0.001 MON") — convert to USDC with 6-decimal formatting ("$5.00", not "$5.000000").

---

## 7. Technical constraints

- Next.js 16 App Router + React 19 + Tailwind v4 (`@import "tailwindcss"` syntax, `@theme` tokens)
- TypeScript strict mode
- wagmi v2 + RainbowKit (wallet-connect path)
- Magic.link SDK (embedded wallet path, being added)
- Safe SDK + Pimlico for ERC-4337 user ops
- **Fonts via `next/font/local`** with bundled files in `public/fonts/`. Do NOT use `next/font/google` — previous Vercel sandbox builds failed on remote fetch.
- **Mobile-first** everything. Tap targets minimum 44px.
- **Accessibility:** WCAG AA contrast, `aria-current="page"` for active nav, focus-visible rings (signal yellow outline), respect `prefers-reduced-motion` for all tilts, press animations, and marquee.

---

## 8. Deliverables

Save output to `C:\Users\hr\Claude Cowork\gemini-output\` with this structure:

```
gemini-output/
├── components/
│   ├── auth/
│   │   ├── SignInScreen.tsx
│   │   └── AllowlistRejection.tsx
│   ├── profile/
│   │   ├── ProfilePage.tsx
│   │   ├── BalanceCard.tsx
│   │   ├── DepositOptions.tsx
│   │   ├── RecoverySection.tsx
│   │   ├── BetHistory.tsx
│   │   └── WithdrawSection.tsx
│   ├── kyc/
│   │   └── KycFlow.tsx
│   ├── deposit/
│   │   ├── MoonPayModal.tsx
│   │   ├── NairaModal.tsx
│   │   ├── CryptoDepositModal.tsx
│   │   ├── BridgeSignPrompt.tsx
│   │   └── PaymentStatePill.tsx
│   ├── market/
│   │   ├── MarketCard.tsx (restyle)
│   │   ├── MarketDetail.tsx (restyle)
│   │   ├── BetSheet.tsx (restyle — keep math)
│   │   └── BetTile.tsx
│   ├── create/
│   │   └── CreateMarketForm.tsx (restyle)
│   ├── me/
│   │   └── PositionsPage.tsx (restyle)
│   ├── admin/
│   │   ├── AdminTable.tsx
│   │   ├── AllowlistManagement.tsx
│   │   └── AnalyticsCharts.tsx (restyle)
│   └── shared/
│       ├── Header.tsx
│       ├── Sidebar.tsx (restyle)
│       ├── BottomTabBar.tsx
│       ├── PriceTicker.tsx (restyle)
│       ├── Toast.tsx
│       └── Modal.tsx
├── pages/
│   ├── HomePage.tsx
│   └── SignInPage.tsx
├── styles/
│   └── mako-components.css (any new .mako-* classes beyond mako-brand.css)
└── README.md (integration notes)
```

For each component:
- TypeScript props interface at top
- Mock data inline (Claude replaces with real hooks)
- All states demonstrated (loading, empty, error, success) — either as variants or inline comments
- Tailwind classes only — no inline styles, no styled-components

The integration README should list:
- Which files go where in `mako-markets/src/`
- Font file download URLs (Bricolage + Inter variable .woff2)
- Which existing components are replaced vs restyled
- Any new `.mako-*` classes added beyond mako-brand.css

---

## 9. Out of scope

Do NOT:
- Redesign the smart contract (separate workstream)
- Modify the brand system (fonts, colors, shapes all locked)
- Propose alternative tech stacks
- Design Krait or Cuttlefish (different products)
- Build working integrations (MoonPay SDK, Magic SDK, Pimlico — Claude wires these)
- Add dependencies without flagging in the README
- Make the design "safer" or "more conservative" — neobrutalist and playful is the point

---

## 10. Voice and tone

Mako is **direct and a touch playful.** Not corporate. Not sarcastic. Not hype-bro crypto.

- Good: "Your USDC arrived on Base. Bridge to Monad to bet."
- Bad: "🎉 Awesome! Your funds have landed! Let's GO!"
- Also bad: "Settlement complete. Proceed to market selection."

Mixed case for copy, UPPERCASE for structural labels only. No em-dashes in copy — use commas, periods, colons.

---

## 11. Priorities (ordered)

1. **Clarity of money state** — user always knows spendable balance, pending, failed
2. **Onboarding simplicity** — email-to-first-bet < 90 seconds for web2 users
3. **Neobrutalist playfulness** — tilts, hard shadows, stickers, oversized Bricolage numbers
4. **Mobile-first UX** — most users on phones
5. **Honest security copy** — don't hide email-compromise risk, explain it once and move on
6. **Consistency** — same button, card, modal pattern across every screen

Lean into the neobrutalist. Mako should look like nothing else on Monad.
