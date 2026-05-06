'use client';

import { useState } from 'react';

import { type AuthedUser } from '@/lib/use-user';
import { TotpEnrollmentModal } from './TotpEnrollmentModal';
import { TotpDisableModal } from './TotpDisableModal';
import { RegenerateRecoveryCodesModal } from './RegenerateRecoveryCodesModal';

// ----------------------------------------------------------------------------
// TotpSection
//
// Magic-only 2FA controls. Renders inside /profile's SECURITY card.
// Wallet-only branch (user === null) renders nothing — the wallet
// copy lives in /profile/page.tsx outside this component because
// the backend routes 401 wallet-only sessions, so showing ENABLE /
// DISABLE / REGENERATE buttons would be a UX dead-end.
//
// State machine:
//   user.totpEnabled === false → ENABLE 2FA (opens enrollment modal)
//   user.totpEnabled === true → DISABLE 2FA + REGENERATE RECOVERY CODES
//                               (each opens its own modal)
//
// Modal ownership is local to this section (each modal has its own
// boolean open-flag here). The /profile page's `activeModal` state
// machine for export / send / switch is independent. The two systems
// are NOT centralised — see Sub-4D smoke step 19 + the round-2
// modal-stacking risk note: the load-bearing invariant is each
// modal's full-viewport backdrop with `pointer-events: auto` at
// `z-[100]`, NOT the dismissal arbitrator (which only governs
// dismissal of the active modal).
// ----------------------------------------------------------------------------

type TotpSectionProps = {
  user: AuthedUser | null;
};

export function TotpSection({ user }: TotpSectionProps) {
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  if (!user) return null;
  // Magic-only by definition. Currently called only inside
  // IdentityBlock's magic branch, so this guard is defensive — but
  // cheap, and keeps the discriminated narrow local rather than
  // depending on the parent's branch shape.
  if (user.authType !== 'magic') return null;

  const enabled = user.totpEnabled;
  const enabledAtLabel = user.totpEnabledAt
    ? new Date(user.totpEnabledAt).toLocaleDateString()
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span
          role="status"
          aria-live="polite"
          className={`mako-sticker ${enabled ? 'mako-sticker--ink' : ''} whitespace-nowrap`}
        >
          {enabled
            ? `2FA ENABLED · Enabled ${enabledAtLabel ?? ''}`.trim()
            : '2FA DISABLED'}
        </span>
      </div>

      <p className="mako-body text-sm text-ink leading-relaxed">
        Two-factor authentication adds a second step to sign-in. You enter a
        6-digit code from an authenticator app (Google Authenticator, Authy,
        1Password, etc.) in addition to your email OTP. Recovery codes are
        one-time backups in case you lose your authenticator.
      </p>

      {!enabled && (
        <button
          type="button"
          onClick={() => setEnrollOpen(true)}
          className="mako-button mako-button--action self-start"
        >
          ENABLE 2FA
        </button>
      )}

      {enabled && (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => setDisableOpen(true)}
              className="mako-button mako-button--no"
            >
              DISABLE 2FA
            </button>
            <button
              type="button"
              onClick={() => setRegenerateOpen(true)}
              className="mako-button mako-button--ghost"
            >
              REGENERATE RECOVERY CODES
            </button>
          </div>
          <p className="mako-body text-xs text-ink leading-relaxed bg-paper border-2 border-ink rounded-xl p-3 mt-1">
            <strong>Did you save your recovery codes?</strong> They were
            shown only at enrollment and can&apos;t be viewed again. Store
            them in a password manager, encrypted drive (e.g., Proton
            Drive), or print them — not in the same email account that
            signs in to Mako. If you lost them, click{' '}
            <strong>REGENERATE RECOVERY CODES</strong> to issue a fresh
            batch (this invalidates the old ones).
          </p>
        </>
      )}

      <TotpEnrollmentModal
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
      />
      <TotpDisableModal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
      />
      <RegenerateRecoveryCodesModal
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
      />
    </div>
  );
}
