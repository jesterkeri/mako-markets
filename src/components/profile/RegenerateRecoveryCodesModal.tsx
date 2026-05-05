'use client';

/* eslint-disable react-hooks/set-state-in-effect --
   Two effects in this file legitimately call setState (same
   pattern as TotpDisableModal): reset-on-open + lockout
   auto-transition. React 18+ batches the resets and the
   transition is intentional.
*/

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useFocusTrap } from '@/lib/use-focus-trap';
import { useModalCloseArbitrator } from '@/lib/modal-close-arbitrator';
import { USER_QUERY_KEY } from '@/lib/use-user';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

// ----------------------------------------------------------------------------
// RegenerateRecoveryCodesModal
//
// Issue a fresh batch of 10 recovery codes when the user has lost
// theirs. TOTP-only — server explicitly rejects `recoveryCode` on
// this route (Group 2B). Accepting only TOTP means a recovery
// code can't bootstrap further recovery-code generation, which
// would loosen the "code consumed once, batch discarded on
// regenerate" guarantee.
//
// Phase machine:
//   idle           → form editable
//   submitting     → POST in flight
//   recovery_codes → 10 plaintext codes shown ONCE, save-gate active
//   locked         → 429 totp_locked, countdown to retryAt
//   error          → 500 from server, retry button
//
// Save-gate: identical to TotpEnrollmentModal's recovery_codes
// phase. Codes are returned in the success response and shown
// only on this client surface — losing them after server-side
// regeneration would lock the user out of the recovery path.
// ----------------------------------------------------------------------------

type Phase =
  | 'idle'
  | 'submitting'
  | 'recovery_codes'
  | 'locked'
  | 'error';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function RegenerateRecoveryCodesModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('idle');
  const [code, setCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [retryAt, setRetryAt] = useState<Date | null>(null);
  // Lazy initializer (see TotpDisableModal for rationale).
  const [now, setNow] = useState<number>(() => Date.now());

  const mountedRef = useRef(true);
  const ctrlRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  // Reset state on open. Cleanup aborts in-flight + flips mounted.
  // Bump reqIdRef on every open transition so a late response
  // from a prior open is invalidated even if the React instance
  // is the same.
  useEffect(() => {
    if (!open) return;
    mountedRef.current = true;
    reqIdRef.current++;
    setPhase('idle');
    setCode('');
    setErrorMsg('');
    setRecoveryCodes([]);
    setSavedConfirmed(false);
    setRetryAt(null);
    return () => {
      mountedRef.current = false;
      ctrlRef.current?.abort();
    };
  }, [open]);

  // Lockout countdown ticker.
  useEffect(() => {
    if (phase !== 'locked' || !retryAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase, retryAt]);

  useEffect(() => {
    if (phase !== 'locked' || !retryAt) return;
    if (retryAt.getTime() <= now) {
      setPhase('idle');
      setRetryAt(null);
      setErrorMsg('');
    }
  }, [phase, retryAt, now]);

  const allowedToClose = () => {
    if (phase === 'recovery_codes' && !savedConfirmed) return false;
    return true;
  };

  const arbiter = useModalCloseArbitrator({
    open,
    allowed: allowedToClose,
    onClose: () => {
      ctrlRef.current?.abort();
      // No optimistic cache flip needed — totpEnabled is unchanged
      // by this flow (only the recovery_codes table is touched
      // server-side). /me refetch picks up no change.
      void queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      onClose();
    },
    dialogRef,
  });

  useFocusTrap({
    open,
    containerRef: dialogRef,
    initialFocusRef: codeInputRef,
  });

  // Per-phase focus on transition to 'recovery_codes' (codex
  // round-1 MINOR 1 on Sub-C). useFocusTrap only applies initial
  // focus on the open flip; the COPY ALL button needs to be
  // targeted when codes appear so keyboard walk through the panel
  // is coherent.
  useEffect(() => {
    if (!open || phase !== 'recovery_codes' || !dialogRef.current) return;
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
  }, [open, phase]);

  if (!open) return null;

  async function handleSubmit() {
    if (phase !== 'idle') return;
    const trimmed = code.trim();
    if (!/^[0-9]{6}$/.test(trimmed)) {
      setErrorMsg('Enter the 6-digit code from your authenticator.');
      return;
    }

    setPhase('submitting');
    setErrorMsg('');

    const myReqId = ++reqIdRef.current;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    try {
      const res = await fetch('/api/user/totp/regenerate-recovery-codes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        // Body intentionally only carries totpCode — server rejects
        // recoveryCode for this route per Group 2B.
        body: JSON.stringify({ totpCode: trimmed }),
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

      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        retryAt?: string;
      };
      if (!mountedRef.current || reqIdRef.current !== myReqId) return;

      if (res.status === 429 && json.error === 'totp_locked' && json.retryAt) {
        setRetryAt(new Date(json.retryAt));
        setNow(Date.now());
        setPhase('locked');
        setErrorMsg('');
        return;
      }
      if (res.status === 401 && json.error === 'factor_failed') {
        setPhase('idle');
        setCode('');
        setErrorMsg(
          'That code is wrong. Try a fresh one from your authenticator.',
        );
        return;
      }
      if (res.status === 409 && json.error === 'not_enabled') {
        // Drift — 2FA was disabled in another tab / device. Refetch
        // and dismiss; UI flips to DISABLED state.
        await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;
        onClose();
        return;
      }
      setPhase('error');
      setErrorMsg('Could not regenerate codes right now. Try again.');
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (!mountedRef.current || reqIdRef.current !== myReqId) return;
      console.error('[totp-regenerate] failed', e);
      setPhase('error');
      setErrorMsg('Network error. Please retry.');
    }
  }

  // Phase-aware aria description (codex round-1 MINOR 2 on Sub-C):
  // dialog points at #totp-regen-desc unconditionally; the visible
  // copy varies by phase but the id-bearing element is always
  // mounted.
  const ariaDescription = (() => {
    switch (phase) {
      case 'idle':
      case 'submitting':
        return 'Confirm with your authenticator code to generate new recovery codes.';
      case 'recovery_codes':
        return 'Save these new recovery codes. They are shown only once.';
      case 'locked':
        return 'Locked. Try again after the countdown elapses.';
      case 'error':
        return errorMsg || 'Could not regenerate codes.';
      default:
        return '';
    }
  })();

  const remainingMs = retryAt ? Math.max(0, retryAt.getTime() - now) : 0;
  const remainingMin = Math.floor(remainingMs / 60_000);
  const remainingSec = Math.floor((remainingMs % 60_000) / 1000);
  const formattedCountdown = `${String(remainingMin).padStart(2, '0')}:${String(remainingSec).padStart(2, '0')}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="totp-regen-title"
      aria-describedby="totp-regen-desc"
      className="fixed inset-0 z-[100] bg-[var(--color-background)]/80 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={arbiter.onBackdropClick}
    >
      <div
        ref={dialogRef}
        className="mako-card w-full max-w-lg flex flex-col p-0 overflow-hidden text-ink max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b-2 border-ink bg-surface-elevated flex items-center justify-between gap-3">
          <h2 id="totp-regen-title" className="mako-display text-2xl">
            REGENERATE RECOVERY CODES
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
          {/* Stable aria-describedby target — always mounted, phase-
              aware screen-reader copy (codex round-1 MINOR 2 on
              Sub-C). */}
          <span
            id="totp-regen-desc"
            className="sr-only"
            aria-live="polite"
          >
            {ariaDescription}
          </span>

          {phase === 'idle' || phase === 'submitting' ? (
            <>
              <p className="mako-body text-sm text-ink leading-relaxed">
                This generates a new batch of 10 recovery codes and{' '}
                <strong>invalidates the previous batch</strong>. Confirm with
                your authenticator code.
              </p>
              <div className="flex flex-col gap-2">
                <label
                  className="mako-label text-[10px] text-ink"
                  htmlFor="totp-regen-code"
                >
                  6-DIGIT CODE
                </label>
                <input
                  id="totp-regen-code"
                  ref={codeInputRef}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={phase === 'submitting'}
                  className="mako-input mako-mono text-lg bg-white tracking-widest text-center"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSubmit();
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
                onClick={() => void handleSubmit()}
                disabled={
                  phase === 'submitting' || code.replace(/\D/g, '').length !== 6
                }
                className="mako-button mako-button--action"
              >
                {phase === 'submitting' ? 'GENERATING…' : 'GENERATE NEW CODES'}
              </button>
            </>
          ) : null}

          {phase === 'locked' && (
            <div
              role="status"
              aria-live="polite"
              className="bg-mako-red/10 border-2 border-mako-red p-4 rounded-xl flex flex-col gap-2"
            >
              <p className="mako-label text-mako-red">LOCKED</p>
              <p className="mako-body text-sm text-ink">
                Too many failed attempts. Try again in{' '}
                <span className="mako-mono font-bold">{formattedCountdown}</span>
                .
              </p>
            </div>
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
                <strong>Save these new recovery codes now.</strong> They are
                shown <strong>only once</strong>. Your previous codes no
                longer work. Store them in a password manager, encrypted
                drive (e.g., Proton Drive), or print them — not in the
                same email account that signs in to Mako.
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
