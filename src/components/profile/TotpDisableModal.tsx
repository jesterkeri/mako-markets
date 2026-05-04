'use client';

/* eslint-disable react-hooks/set-state-in-effect --
   Two effects in this file legitimately call setState:
   1. The reset-on-open effect — initialises phase + form fields
      when the parent flips `open` to true. React 18+ batches the
      setStates in a single commit so cascading renders don't
      occur.
   2. The lockout auto-transition effect — when retryAt elapses
      we flip phase back to 'idle'. The setNow ticker drives
      this; the dependency on `now` makes the transition
      intentional. Both patterns are documented in the Group 4
      plan modal architecture.
*/

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useFocusTrap } from '@/lib/use-focus-trap';
import { useModalCloseArbitrator } from '@/lib/modal-close-arbitrator';
import { USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// TotpDisableModal
//
// Turn off 2FA. Body: exactly one of `totpCode` or `recoveryCode`.
// On success, server clears totp_secret + totp_enabled_at +
// totp_failed_attempts + totp_locked_until + last_used_step and
// deletes all recovery_codes for the user. Single transaction.
//
// Phase machine:
//   idle       → form editable
//   submitting → POST in flight, form disabled
//   locked     → 429 totp_locked, countdown to retryAt
//   error      → 500 from server, retry button
//
// Async safety: per-instance AbortController + mountedRef guard
// (Group 4 plan invariant; same pattern as IdentityBlock + Sub-4A
// modal primitives). Late responses after close are dropped.
//
// Dismissal: useModalCloseArbitrator routes close button +
// Escape + backdrop + beforeunload through one `allowed()`
// predicate. This modal has NO save-gate (no recovery codes shown
// here), so allowed() always returns true. The arbitrator still
// handles event swallowing + listener lifecycle.
// ----------------------------------------------------------------------------

type FactorMode = 'totp' | 'recovery';
type Phase = 'idle' | 'submitting' | 'locked' | 'error';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function TotpDisableModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('idle');
  const [factorMode, setFactorMode] = useState<FactorMode>('totp');
  const [code, setCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [retryAt, setRetryAt] = useState<Date | null>(null);
  // Lazy initializer to keep Date.now() out of every render path —
  // React 19's purity-during-render lint flags the eager form.
  const [now, setNow] = useState<number>(() => Date.now());

  const mountedRef = useRef(true);
  const ctrlRef = useRef<AbortController | null>(null);
  // Per-attempt request id — guards against close/reopen races
  // where a late response from a prior open could mutate the new
  // modal instance (codex round-1 MAJOR on Sub-C). Each submit
  // increments the id; the response handler bails if the id has
  // moved on.
  const reqIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLInputElement | null>(null);

  // Reset state on open. Cleanup aborts in-flight + flips mounted.
  // Bump reqIdRef on every open transition so a late response from
  // a PRIOR open (that this instance technically remembers across
  // close+reopen because the React component is the same instance
  // — the parent toggles `open`) is invalidated.
  useEffect(() => {
    if (!open) return;
    mountedRef.current = true;
    reqIdRef.current++;
    setPhase('idle');
    setFactorMode('totp');
    setCode('');
    setErrorMsg('');
    setRetryAt(null);
    return () => {
      mountedRef.current = false;
      ctrlRef.current?.abort();
    };
  }, [open]);

  // Lockout countdown ticker. Only runs while in 'locked' phase
  // and there's a retryAt. Stops automatically when phase changes.
  useEffect(() => {
    if (phase !== 'locked' || !retryAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase, retryAt]);

  // Auto-transition out of 'locked' when retryAt elapses.
  useEffect(() => {
    if (phase !== 'locked' || !retryAt) return;
    if (retryAt.getTime() <= now) {
      setPhase('idle');
      setRetryAt(null);
      setErrorMsg('');
    }
  }, [phase, retryAt, now]);

  const arbiter = useModalCloseArbitrator({
    open,
    allowed: () => true,
    onClose: () => {
      ctrlRef.current?.abort();
      onClose();
    },
    dialogRef,
  });

  useFocusTrap({ open, containerRef: dialogRef, initialFocusRef });

  if (!open) return null;

  function changeFactorMode(next: FactorMode) {
    setFactorMode(next);
    setCode('');
    setErrorMsg('');
  }

  async function handleSubmit() {
    if (phase !== 'idle') return;
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setErrorMsg('Enter a code.');
      return;
    }

    setPhase('submitting');
    setErrorMsg('');

    const myReqId = ++reqIdRef.current;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    const body =
      factorMode === 'totp'
        ? { totpCode: trimmed }
        : { recoveryCode: trimmed };

    try {
      const res = await fetch('/api/user/totp/disable', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!mountedRef.current || reqIdRef.current !== myReqId) return;

      if (res.ok) {
        // Optimistic cache update — flip totpEnabled false +
        // clear totpEnabledAt. /me refetch overwrites with the
        // authoritative value within ~50ms.
        queryClient.setQueryData<AuthedUser>(USER_QUERY_KEY, (old) =>
          old && old.authed
            ? { ...old, totpEnabled: false, totpEnabledAt: null }
            : old,
        );
        await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
        // Re-check after the awaited invalidate — close/reopen
        // during the await would otherwise let this stale success
        // dismiss a fresh modal instance (codex round-2 MINOR 1).
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;
        onClose();
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
      if (res.status === 409 && json.error === 'not_enabled') {
        // State drift — another device disabled 2FA in the meantime.
        // Refresh the cache and dismiss; the UI flips to DISABLED.
        await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
        if (!mountedRef.current || reqIdRef.current !== myReqId) return;
        onClose();
        return;
      }
      if (res.status === 401 && json.error === 'factor_failed') {
        setPhase('idle');
        setCode('');
        setErrorMsg(
          factorMode === 'totp'
            ? 'That code is wrong. Try again with a fresh code from your authenticator.'
            : 'That recovery code is wrong or already used. Try a different one.',
        );
        return;
      }
      // 500 + anything else.
      setPhase('error');
      setErrorMsg(
        'Could not disable 2FA right now. Try again in a moment.',
      );
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (!mountedRef.current || reqIdRef.current !== myReqId) return;
      console.error('[totp-disable] submit failed', e);
      setPhase('error');
      setErrorMsg('Network error. Please retry.');
    }
  }

  const remainingMs = retryAt ? Math.max(0, retryAt.getTime() - now) : 0;
  const remainingMin = Math.floor(remainingMs / 60_000);
  const remainingSec = Math.floor((remainingMs % 60_000) / 1000);
  const formattedCountdown = `${String(remainingMin).padStart(2, '0')}:${String(remainingSec).padStart(2, '0')}`;

  const submitDisabled = phase === 'submitting' || phase === 'locked';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="totp-disable-title"
      aria-describedby="totp-disable-desc"
      className="fixed inset-0 z-[100] bg-[var(--color-background)]/80 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={arbiter.onBackdropClick}
    >
      <div
        ref={dialogRef}
        className="mako-card w-full max-w-md flex flex-col p-0 overflow-hidden text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b-2 border-ink bg-surface-elevated flex items-center justify-between gap-3">
          <h2 id="totp-disable-title" className="mako-display text-2xl text-mako-red">
            DISABLE 2FA
          </h2>
          <button
            type="button"
            onClick={arbiter.requestClose}
            className="mako-label text-[10px] text-ink opacity-60 hover:opacity-100 hover:underline"
            aria-label="Close"
          >
            CLOSE
          </button>
        </div>

        <div className="p-6 flex flex-col gap-4">
          <p id="totp-disable-desc" className="mako-body text-sm text-ink leading-relaxed">
            Confirm with your authenticator code or one of your recovery
            codes. After disabling, your saved recovery codes are deleted.
          </p>

          {phase === 'locked' ? (
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
          ) : (
            <>
              <div role="radiogroup" aria-label="Factor type" className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="factor"
                    checked={factorMode === 'totp'}
                    onChange={() => changeFactorMode('totp')}
                    disabled={phase === 'submitting'}
                  />
                  <span className="mako-label text-[10px]">AUTHENTICATOR CODE</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="factor"
                    checked={factorMode === 'recovery'}
                    onChange={() => changeFactorMode('recovery')}
                    disabled={phase === 'submitting'}
                  />
                  <span className="mako-label text-[10px]">RECOVERY CODE</span>
                </label>
              </div>

              <div className="flex flex-col gap-2">
                <label
                  className="mako-label text-[10px] text-ink"
                  htmlFor="totp-disable-input"
                >
                  {factorMode === 'totp' ? '6-DIGIT CODE' : 'RECOVERY CODE'}
                </label>
                <input
                  id="totp-disable-input"
                  ref={initialFocusRef}
                  type="text"
                  inputMode={factorMode === 'totp' ? 'numeric' : 'text'}
                  pattern={factorMode === 'totp' ? '[0-9]*' : undefined}
                  maxLength={factorMode === 'totp' ? 6 : 32}
                  autoComplete={factorMode === 'totp' ? 'one-time-code' : 'off'}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="mako-input mako-mono text-sm bg-white"
                  disabled={phase === 'submitting'}
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
            </>
          )}

          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitDisabled}
              className="mako-button mako-button--no flex-1"
            >
              {phase === 'submitting' ? 'DISABLING…' : 'DISABLE'}
            </button>
            <button
              type="button"
              onClick={arbiter.requestClose}
              disabled={phase === 'submitting'}
              className="mako-button mako-button--ghost flex-1"
            >
              CANCEL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
