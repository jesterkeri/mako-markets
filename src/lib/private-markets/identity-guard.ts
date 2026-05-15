// ----------------------------------------------------------------------------
// src/lib/private-markets/identity-guard.ts
//
// Phase 2C-2 Step 3: pure helper that answers "is the connected wallet
// the same address as the signed-in wallet session?" Used in two places:
//
//   1. /create/private page-level: drives the WalletDriftBanner +
//      per-form `drifted` prop that disables every submit button when
//      identity is misaligned.
//   2. usePmCreateMarket().submit() in the wallet branch: re-checks at
//      submit time, defensively, so a connect-then-disconnect-then-
//      submit race can't slip past the page-level check.
//
// Magic sessions always pass (no wallet to drift against).
// ----------------------------------------------------------------------------

export interface IdentityCheckArgs {
  authType: 'magic' | 'wallet' | null | undefined;
  sessionWalletAddress: string | null | undefined;
  connectedAddress: string | null | undefined;
}

/// Returns true iff identity is aligned. Specifically:
///   - Magic session                                       → true
///   - Wallet session + both addresses present + match     → true
///   - Wallet session + either address missing             → false
///   - Wallet session + addresses present but differ       → false
///   - Unauthed (authType null / undefined)                → false
///
/// Both addresses are compared lowercased to avoid checksum-vs-
/// non-checksum false negatives. Empty strings are treated as missing.
export function isWalletIdentityAligned(args: IdentityCheckArgs): boolean {
  if (args.authType === 'magic') return true;
  if (args.authType !== 'wallet') return false;

  const sessionLower = args.sessionWalletAddress?.trim().toLowerCase() ?? '';
  const connectedLower = args.connectedAddress?.trim().toLowerCase() ?? '';
  if (sessionLower === '' || connectedLower === '') return false;
  return sessionLower === connectedLower;
}
