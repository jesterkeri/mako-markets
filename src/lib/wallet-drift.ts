import type { AuthedUser } from './use-user';

// ----------------------------------------------------------------------------
// src/lib/wallet-drift.ts
//
// Detects "wallet drift" — a wallet-authed `mako_user_session` whose
// stored wallet_address no longer matches the wagmi-connected wallet.
//
// Why this exists (codex round-2 MAJOR fix from the wallet-profile
// plan): the `mako_user_session` cookie persists for 7 days. The
// wagmi-connected wallet can change at any time (user disconnects,
// switches accounts, signs in via a different wallet provider).
// Without explicit handling, /profile would show the SESSION wallet
// identity (A) while the SEND card and BetSheet operate on the
// CONNECTED wallet (B). Editing a display name updates A; sending
// USDC moves it from B. That's a footgun.
//
// The detection runs at the call-site (page / component), NOT inside
// the hooks. `usePlaceBet`, `useCreateMarket`, `useSendUsdc` stay
// drift-unaware so they remain reusable in non-/profile contexts
// (admin tools, dev surfaces) where the connected wallet IS the right
// signer regardless of the cookie. Each consuming surface reads
// `user` + `connectedWallet` already and the predicate is two
// lowercase-compares — re-computing locally is the smaller move than
// changing every hook's return shape.
//
// Drift is undefined for Magic sessions: a Magic user's identity is
// the cookie, the connected wallet is "advanced/external" (footer
// link), and never the signer for the user's own actions on the
// site. `isWalletDrifted` returns false for Magic-authed users
// regardless of what wallet is connected.
// ----------------------------------------------------------------------------

export function isWalletDrifted(
  user: AuthedUser | null,
  connectedWallet: `0x${string}` | undefined,
): boolean {
  if (!user || user.authType !== 'wallet') return false;
  if (!connectedWallet) return false;
  return connectedWallet.toLowerCase() !== user.walletAddress.toLowerCase();
}
