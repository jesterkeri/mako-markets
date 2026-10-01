'use client';

/* eslint-disable react-hooks/set-state-in-effect --
   The reset-on-open effect initialises phase + form fields when
   the parent flips `open` to true. React 18+ batches the
   setStates in a single commit so cascading renders don't occur.
   The pattern is mirrored in TotpDisableModal +
   RegenerateRecoveryCodesModal and documented in the Group 4
   plan modal architecture section.
*/

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';

import { useFocusTrap } from '@/lib/use-focus-trap';
import { useModalCloseArbitrator } from '@/lib/modal-close-arbitrator';
import { USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';
import { alertLine, CLOSE_ICON, CodeBoxes, fieldLabel, Icon, lead, overlayInput, primaryButton, secondaryButton } from './TwoFactorUi';

// ----------------------------------------------------------------------------
// TotpEnrollmentModal
//
// Turn-on-2FA flow. Three real phases (plus 'verifying' transient
// and 'error'):
//   fetching       → POST /api/user/totp/enroll
//   scan           → QR + secret + 6-digit input
//   verifying      → POST /api/user/totp/verify-enrollment
//   recovery_codes → 10 plaintext codes shown ONCE, save-gate active
//   error          → retry button
//
// **Save-gate (load-bearing)**: in the `recovery_codes` phase the
// dismissal arbitrator's `allowed()` predicate returns false until
// `savedConfirmed === true`. That gates close button + Escape +
// backdrop + beforeunload uniformly. In-app navigation
// (Link/router.push) and same-document Back/Forward are NOT covered
// — App Router exposes no before-navigate hook (see Group 4 plan
// modal-architecture section). Mitigated by full-viewport backdrop
// + focus trap + explicit warning copy.
//
// Async safety: per-attempt request id + AbortController. Late
// /verify-enrollment after modal close is the most dangerous case
// (could splice fresh recovery codes into a closed/reopened
// modal); guarded via reqIdRef + mountedRef.
// ----------------------------------------------------------------------------

type Phase = 'fetching' | 'scan' | 'verifying' | 'recovery_codes' | 'error';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function TotpEnrollmentModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('fetching');
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedConfirmed, setSavedConfirmed] = useState(false);

  const mountedRef = useRef(true);
  const ctrlRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const initialFocusRef = useRef<HTMLElement | null>(null);

  // Reset state on open + kick off /enroll. Cleanup aborts in-flight.
  // The setStates inside this effect look like a cascading-renders
  // anti-pattern but they're not — they all batch into a single
  // commit because React 18+ batches setState calls inside an
  // effect callback. The "open" flip is the only trigger; the
  // resets are intentional initial-state derivation. (See the
  // file-level eslint-disable at the top.)
  useEffect(() => {
    if (!open) return;
    mountedRef.current = true;
    setPhase('fetching');
    setEnrollmentId(null);
    setOtpauthUri(null);
    setCode('');
    setErrorMsg('');
    setRecoveryCodes([]);
    setSavedConfirmed(false);

    const myReqId = ++reqIdRef.current;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    (async () => {
      try {
        const res = await fetch('/api/user/totp/enroll', {
          method: 'POST',
          credentials: 'same-origin',
          signal: ctrl.signal,
        });
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;

        if (res.ok) {
          const body = (await res.json()) as {
            enrollmentId: string;
            otpauthUri: string;
          };
          if (!mountedRef.current || reqIdRef.current !== myReqId) return;
          setEnrollmentId(body.enrollmentId);
          setOtpauthUri(body.otpauthUri);
          setPhase('scan');
          return;
        }

        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;
        if (res.status === 409 && json.error === 'already_enabled') {
          // Another tab / device already enabled 2FA. Refetch +
          // close cleanly; the UI flips to ENABLED.
          await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
          if (!mountedRef.current || reqIdRef.current !== myReqId) return;
          onClose();
          return;
        }
        setPhase('error');
        setErrorMsg('Could not start 2FA setup. Try again in a moment.');
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;
        console.error('[totp-enroll] fetch failed', e);
        setPhase('error');
        setErrorMsg('Network error. Please retry.');
      }
    })();

    return () => {
      mountedRef.current = false;
      ctrlRef.current?.abort();
    };
  }, [open, queryClient, onClose]);

  // Save-gate: dismissal allowed iff we're NOT in recovery_codes,
  // OR we are AND the user has ticked the save checkbox.
  const allowedToClose = () => {
    if (phase === 'recovery_codes' && !savedConfirmed) return false;
    return true;
  };

  const arbiter = useModalCloseArbitrator({
    open,
    allowed: allowedToClose,
    onClose: () => {
      ctrlRef.current?.abort();
      // If close fires from the recovery_codes-with-checkbox path,
      // optimistically write the cache so the /profile UI flips
      // to ENABLED without waiting for the /me refetch.
      if (phase === 'recovery_codes' && savedConfirmed) {
        queryClient.setQueryData<AuthedUser>(USER_QUERY_KEY, (old) =>
          old && old.authed
            ? {
                ...old,
                totpEnabled: true,
                totpEnabledAt: new Date().toISOString(),
              }
            : old,
        );
      }
      void queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      onClose();
    },
    dialogRef,
  });

  useFocusTrap({ open, containerRef: dialogRef, initialFocusRef });

  // Per-phase initial focus (codex round-1 MINOR 1 on Sub-C):
  // useFocusTrap only applies initial focus on the open transition,
  // not on phase changes. The 6-digit input mounts when phase
  // becomes 'scan'; queueMicrotask defers to let the DOM settle
  // before .focus() so focus lands inside the dialog rather than
  // on the page body.
  useEffect(() => {
    if (!open) return;
    if (phase === 'scan' && codeInputRef.current) {
      const el = codeInputRef.current;
      queueMicrotask(() => {
        try {
          el.focus();
        } catch {
          // Element removed mid-microtask; ignore.
        }
      });
    } else if (phase === 'recovery_codes' && dialogRef.current) {
      // Focus the COPY ALL button so the keyboard walk through the
      // panel (COPY ALL → DOWNLOAD → checkbox → CLOSE) is
      // coherent. Find it via the first focusable inside the
      // RecoveryCodesPanel-rendered region — we identify it by
      // text content rather than a ref because the panel is a
      // separate component without a forwarded ref.
      const buttons = Array.from(
        dialogRef.current.querySelectorAll('button'),
      );
      const copyBtn = buttons.find((b) => b.textContent === 'COPY ALL');
      if (copyBtn) {
        queueMicrotask(() => {
          try {
            copyBtn.focus();
          } catch {
            // ignore
          }
        });
      }
    }
  }, [open, phase]);

  if (!open) return null;

  async function handleVerify() {
    if (phase !== 'scan' || !enrollmentId) return;
    const trimmed = code.trim();
    if (!/^[0-9]{6}$/.test(trimmed)) {
      setErrorMsg('Enter the 6-digit code from your authenticator.');
      return;
    }

    setPhase('verifying');
    setErrorMsg('');

    const myReqId = ++reqIdRef.current;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    try {
      const res = await fetch('/api/user/totp/verify-enrollment', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollmentId, code: trimmed }),
        signal: ctrl.signal,
      });
      if (!mountedRef.current || reqIdRef.current !== myReqId) return;

      if (res.ok) {
        const body = (await res.json()) as { recoveryCodes: string[] };
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;
        setRecoveryCodes(body.recoveryCodes);
        setSavedConfirmed(false);
        setPhase('recovery_codes');
        return;
      }

      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!mountedRef.current || reqIdRef.current !== myReqId) return;

      if (res.status === 401 && json.error === 'bad_code') {
        setPhase('scan');
        setCode('');
        setErrorMsg('That code is wrong. Try a fresh one from your authenticator.');
        return;
      }
      if (res.status === 404 && json.error === 'enrollment_invalid') {
        setPhase('error');
        setErrorMsg('Setup expired. Close this and start over.');
        return;
      }
      if (res.status === 409 && json.error === 'already_enabled') {
        await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;
        onClose();
        return;
      }
      setPhase('scan');
      setErrorMsg('Verification failed. Try again.');
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (!mountedRef.current || reqIdRef.current !== myReqId) return;
      console.error('[totp-verify-enrollment] failed', e);
      setPhase('scan');
      setErrorMsg('Network error. Please retry.');
    }
  }

  // Extract base32 secret from the otpauth URI for users whose
  // authenticator app can't scan QR codes.
  const secret = otpauthUri ? extractSecret(otpauthUri) : null;

  // Phase-aware description for aria-describedby. The dialog
  // always points at #totp-enroll-desc (codex round-1 MINOR 2 on
  // Sub-C); the visible copy varies by phase but the id is
  // always rendered, so screen readers don't lose the binding
  // when the phase swaps from 'scan' (visible description) to
  // 'verifying' / 'error' (no visible description in the prior
  // implementation).
  const ariaDescription = (() => {
    switch (phase) {
      case 'fetching':
        return 'Preparing two-factor authentication setup.';
      case 'scan':
        return 'Scan this QR code in your authenticator app, then enter the 6-digit code it generates to confirm.';
      case 'verifying':
        return 'Verifying your code with the server.';
      case 'recovery_codes':
        return 'Save these recovery codes. They are shown only once.';
      case 'error':
        return errorMsg || 'Setup failed.';
      default:
        return '';
    }
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="totp-enroll-title"
      aria-describedby="totp-enroll-desc"
      className="mk-2fa-scrim mk-scrim"
      onClick={arbiter.onBackdropClick}
    >
      <div
        ref={dialogRef}
        className="mk-2fa"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mk-2fa-handle" aria-hidden="true" />
        <button
          type="button"
          onClick={arbiter.requestClose}
          disabled={phase === 'recovery_codes' && !savedConfirmed}
          aria-label="Close"
          className="mk-2fa-close"
        >
          <Icon d={CLOSE_ICON} size={15} />
        </button>
        <h2 id="totp-enroll-title" className="mk-2fa-title">
          Turn on two-factor
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
          {/* Stable aria-describedby target — id stays mounted
              regardless of phase (codex round-1 MINOR 2 on Sub-C).
              The text is a phase-aware screen-reader-only string;
              visible copy lives in the per-phase blocks below. */}
          <span
            id="totp-enroll-desc"
            className="sr-only"
            aria-live="polite"
          >
            {ariaDescription}
          </span>

          {phase === 'fetching' && (
            <p
              role="status"
              aria-live="polite"
              style={lead}
            >
              Preparing setup…
            </p>
          )}

          {phase === 'scan' && otpauthUri && (
            <>
              <p style={lead}>
                Scan this QR code in your authenticator app, then enter the
                6-digit code it generates to confirm.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', padding: 16, borderRadius: 14, background: '#fff', boxShadow: 'var(--edge)' }}>
                <QRCodeSVG value={otpauthUri} size={240} level="M" />
              </div>
              {secret && (
                <details style={{ fontSize: 13, color: 'var(--dim)' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 700, textDecoration: 'underline' }}>
                    Can&apos;t scan? Show the secret instead.
                  </summary>
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <code className="mk-2fa-field" style={{ display: 'block', padding: '12px 14px', background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', color: 'var(--mako-canvas-fg)', fontFamily: 'var(--mako-font-mono)', fontSize: 14, wordBreak: 'break-all' }}>
                      {secret}
                    </code>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(secret)}
                      className="m3-press"
                      style={{ ...secondaryButton(), alignSelf: 'flex-start', height: 34, padding: '0 14px' }}
                    >
                      COPY SECRET
                    </button>
                    <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45 }}>
                      Tip: also save this secret to a password manager or
                      encrypted drive (e.g., Proton Drive, 1Password). It
                      lets you restore the same code on a new phone if you
                      lose your current authenticator.
                    </p>
                  </div>
                </details>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label
                  style={fieldLabel}
                  htmlFor="totp-enroll-code"
                >
                  6-DIGIT CODE
                </label>
                <CodeBoxes value={code} invalid={!!errorMsg}>
                  <input
                    id="totp-enroll-code"
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    style={overlayInput}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleVerify();
                      }
                    }}
                  />
                </CodeBoxes>
              </div>
              {errorMsg && (
                <p
                  role="alert"
                  style={alertLine}
                >
                  {errorMsg}
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleVerify()}
                disabled={code.replace(/\D/g, '').length !== 6}
                className="mako-button--action m3-press m3-scale96"
                style={primaryButton(code.replace(/\D/g, '').length === 6)}
              >
                VERIFY
              </button>
            </>
          )}

          {phase === 'verifying' && (
            <p
              role="status"
              aria-live="polite"
              style={lead}
            >
              Verifying code…
            </p>
          )}

          {phase === 'error' && (
            <>
              <p
                role="alert"
                style={{ ...alertLine, fontSize: 15 }}
              >
                {errorMsg}
              </p>
              <button
                type="button"
                onClick={arbiter.requestClose}
                className="m3-press m3-scale96"
                style={{ ...secondaryButton(), alignSelf: 'flex-start' }}
              >
                CLOSE
              </button>
            </>
          )}

          {phase === 'recovery_codes' && (
            <>
              <p style={lead}>
                <strong style={{ color: 'var(--mako-canvas-fg)' }}>Save these recovery codes now.</strong> They are
                shown <strong style={{ color: 'var(--mako-canvas-fg)' }}>only once</strong>. Each code lets you sign in
                if you lose access to your authenticator. Store them in a
                password manager, encrypted drive (e.g., Proton Drive), or
                print them and keep the paper somewhere safe, not in the
                same email account that signs in to Mako Market.
              </p>
              <RecoveryCodesPanel codes={recoveryCodes} />
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer', marginTop: 2 }}>
                <input
                  type="checkbox"
                  checked={savedConfirmed}
                  onChange={(e) => setSavedConfirmed(e.target.checked)}
                  style={{ marginTop: 2, width: 18, height: 18, accentColor: 'var(--mako-signal)' }}
                />
                <span style={{ fontSize: 14, lineHeight: 1.45, fontWeight: 600 }}>
                  I have saved these backup codes somewhere safe.
                </span>
              </label>
              <button
                type="button"
                onClick={arbiter.requestClose}
                disabled={!savedConfirmed}
                className="mako-button--action m3-press m3-scale96"
                style={primaryButton(savedConfirmed)}
              >
                {savedConfirmed ? 'CLOSE' : 'CHECK THE BOX TO CONTINUE'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function extractSecret(otpauthUri: string): string | null {
  try {
    const u = new URL(otpauthUri);
    return u.searchParams.get('secret');
  } catch {
    return null;
  }
}
