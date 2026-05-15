'use client';

// ----------------------------------------------------------------------------
// src/components/PersonalOutcomeBanner.tsx
//
// claim-magic-parity: always-visible personal-outcome banner shown above
// the claim button on resolved markets. Before this banner existed, users
// who lost saw nothing (ClaimButton returned null when claimableUsdc was
// 0n), so they couldn't tell whether they'd participated and lost or
// never bet at all. Magic-auth users on a winning side ALSO saw nothing
// because ClaimButton's wagmi `useAccount()` read was undefined for them.
//
// This component is pure presentational. Inputs are pre-computed by the
// parent (which knows the auth-resolved betting account). Renders one of:
//   - WON (signal-green, prominent, with claim amount)
//   - REFUND (signal-green, prominent, with refund amount)
//   - LOST (mako-red, neutral tone, with forfeited amount — never the
//           claim button below, since claimableUsdc would be 0n)
//   - CLAIMED (dimmed, checkmark, with the claimed amount)
//
// Brand-token-only. Dual-theme verified. No em-dashes per
// feedback_no_em_dashes (uses colons and periods).
// ----------------------------------------------------------------------------

import { formatUsdc } from '@/lib/usdc';

export type PersonalOutcomeKind = 'won' | 'lost' | 'refund';

export interface PersonalOutcomeBannerProps {
  kind: PersonalOutcomeKind;
  /// For 'won' / 'refund': the claimable amount. For 'lost': the
  /// forfeited stake the user's losing side had on the market.
  amountUsdc: bigint;
  /// When true and kind is 'won' or 'refund', the banner switches to
  /// a dimmed CLAIMED state so the user sees their settled position
  /// even after the claim landed. Ignored for 'lost'.
  hasClaimed: boolean;
  /// Compact density for /me row inline rendering (single short line).
  /// Default is the full density used on the market detail page.
  compact?: boolean;
}

export function PersonalOutcomeBanner({
  kind,
  amountUsdc,
  hasClaimed,
  compact = false,
}: PersonalOutcomeBannerProps) {
  // ─── Label + tone ───────────────────────────────────────────────
  let primaryLabel: string;
  let amountSuffix: string;
  let isPositive: boolean; // controls signal-green vs mako-red bg
  if (kind === 'won') {
    primaryLabel = hasClaimed ? 'YOU WON. CLAIMED' : 'YOU WON';
    amountSuffix = hasClaimed ? 'USDC' : 'CLAIMABLE USDC';
    isPositive = true;
  } else if (kind === 'refund') {
    primaryLabel = hasClaimed ? 'REFUND CLAIMED' : 'REFUND AVAILABLE';
    amountSuffix = hasClaimed ? 'USDC' : 'USDC';
    isPositive = true;
  } else {
    primaryLabel = 'YOU LOST';
    amountSuffix = 'FORFEITED USDC';
    isPositive = false;
  }

  // ─── Style ──────────────────────────────────────────────────────
  // Positive: signal-yellow fill, ink text. Negative: mako-red border
  // with ink text on a paper bg (kept readable in both themes; we
  // don't fill the red because it would dominate the page).
  const positiveBg = hasClaimed ? 'bg-paper' : 'bg-signal';
  const negativeBg = 'bg-paper';
  const positiveBorder = 'border-ink';
  const negativeBorder = 'border-mako-red';
  const containerClasses = isPositive
    ? `${positiveBg} ${positiveBorder}`
    : `${negativeBg} ${negativeBorder}`;

  if (compact) {
    return (
      <div
        className={`flex items-center justify-between gap-3 px-3 py-2 border-2 ${containerClasses} rounded-xl`}
      >
        <span
          className={`mako-label text-[10px] tracking-widest ${isPositive ? 'text-ink' : 'text-mako-red'}`}
        >
          {primaryLabel}
        </span>
        <span
          className={`mako-mono font-bold tabular-nums text-sm ${isPositive ? 'text-ink' : 'text-mako-red'}`}
        >
          {hasClaimed && <span className="mr-1">✓</span>}${formatUsdc(amountUsdc)}{' '}
          <span className="opacity-60">{amountSuffix}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 px-6 py-5 border-2 ${containerClasses} rounded-2xl`}
    >
      <span
        className={`mako-label tracking-widest ${isPositive ? 'text-ink' : 'text-mako-red'}`}
      >
        {hasClaimed && isPositive && <span className="mr-1">✓</span>}
        {primaryLabel}
      </span>
      <span
        className={`mako-display text-5xl md:text-6xl tabular-nums tracking-tighter ${isPositive ? 'text-ink' : 'text-mako-red'}`}
      >
        <span className="text-3xl opacity-50 mr-1">$</span>
        {formatUsdc(amountUsdc)}
      </span>
      <span
        className={`mako-label text-[10px] tracking-widest ${isPositive ? 'text-ink/70' : 'text-mako-red/80'}`}
      >
        {amountSuffix}
      </span>
    </div>
  );
}
