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
      className="fixed inset-0 z-[100] bg-[var(--color-background)]/80 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={arbiter.onBackdropClick}
    >
      <div
        ref={dialogRef}
        className="mako-card w-full max-w-lg flex flex-col p-0 overflow-hidden text-ink max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b-2 border-ink bg-surface-elevated flex items-center justify-between gap-3">
          <h2 id="totp-enroll-title" className="mako-display text-2xl">
            ENABLE 2FA
          </h2>
          <button
            type="button"
            onClick={arbiter.requestClose}
            disabled={phase === 'recovery_codes' && !savedConfirmed}
            aria-label="Close"
            className="mako-label text-[10px] text-ink opacity-60 hover:opacity-100 hover:underline disabled:opacity-30 disabled:cursor-not-allowed"
          >
            CLOSE
          </button>
        </div>

        <div className="p-6 flex flex-col gap-4">
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
              className="mako-body text-sm text-ink"
            >
              Preparing setup…
            </p>
          )}

          {phase === 'scan' && otpauthUri && (
            <>
              <p className="mako-body text-sm text-ink leading-relaxed">
                Scan this QR code in your authenticator app, then enter the
                6-digit code it generates to confirm.
              </p>
              <div className="flex justify-center bg-paper border-2 border-ink rounded-xl p-4">
                <QRCodeSVG value={otpauthUri} size={240} level="M" />
              </div>
              {secret && (
                <details className="mako-body text-xs text-muted">
                  <summary className="cursor-pointer hover:text-ink">
                    Can&apos;t scan? Show the secret instead.
                  </summary>
                  <div className="mt-2 flex flex-col gap-2">
                    <code className="mako-mono text-sm bg-paper border-2 border-ink p-3 rounded-xl break-all">
                      {secret}
                    </code>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(secret)}
                      className="mako-button mako-label text-[10px] self-start"
                    >
                      COPY SECRET
                    </button>
                  </div>
                </details>
              )}
              <div className="flex flex-col gap-2">
                <label
                  className="mako-label text-[10px] text-ink"
                  htmlFor="totp-enroll-code"
                >
                  6-DIGIT CODE
                </label>
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
                  className="mako-input mako-mono text-lg bg-white tracking-widest text-center"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleVerify();
                    }
                  }}
                />
              </div>
              {errorMsg && (
                <p
                  role="alert"
                  className="mako-body text-xs font-medium text-mako-red"
                >
                  {errorMsg}
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleVerify()}
                disabled={code.replace(/\D/g, '').length !== 6}
                className="mako-button mako-button--action"
              >
                VERIFY
              </button>
            </>
          )}

          {phase === 'verifying' && (
            <p
              role="status"
              aria-live="polite"
              className="mako-body text-sm text-ink"
            >
              Verifying code…
            </p>
          )}

          {phase === 'error' && (
            <>
              <p
                role="alert"
                className="mako-body text-sm font-medium text-mako-red"
              >
                {errorMsg}
              </p>
              <button
                type="button"
                onClick={arbiter.requestClose}
                className="mako-button mako-button--ghost self-start"
              >
                CLOSE
              </button>
            </>
          )}

          {phase === 'recovery_codes' && (
            <>
              <p className="mako-body text-sm text-ink leading-relaxed">
                <strong>Save these recovery codes now.</strong> They are
                shown <strong>only once</strong>. Each code lets you sign in
                if you lose access to your authenticator. Store them in a
                password manager or print them.
              </p>
              <RecoveryCodesPanel codes={recoveryCodes} />
              <label className="flex items-start gap-3 cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={savedConfirmed}
                  onChange={(e) => setSavedConfirmed(e.target.checked)}
                  className="mt-1"
                />
                <span className="mako-body text-sm text-ink">
                  I have saved these backup codes somewhere safe.
                </span>
              </label>
              <button
                type="button"
                onClick={arbiter.requestClose}
                disabled={!savedConfirmed}
                className="mako-button mako-button--action disabled:opacity-50 disabled:cursor-not-allowed"
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
