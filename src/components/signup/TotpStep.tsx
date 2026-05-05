'use client';

import { useEffect, useState } from 'react';

// ----------------------------------------------------------------------------
// TotpStep
//
// Second-factor sign-in UI on /signup. Rendered when /api/user/auth
// returns { status: 'totp_required', challengeId } — i.e., the user
// passed Magic OTP but their account has TOTP enabled.
//
// Three sub-states (mutually exclusive, evaluated in order):
//   1. terminal (challenge_invalid / eoa_drift): challenge can't be
//      retried in place. Shows alert + RESTART SIGN-IN button that
//      returns the parent to the email form.
//   2. locked (lockedUntil set): server-side lockout in flight. Input
//      hidden; live MM:SS countdown ticks down. Parent's interval-
//      driven setState is the source of truth for clearing
//      lockedUntil; this component's local 500ms tick is for display
//      refresh only.
//   3. input (default): TOTP or recovery-code entry. The input id and
//      label change with `mode` so screen readers track which factor
//      is in flight; switching mode also clears the input value so a
//      half-typed code doesn't leak across factors.
//
// State + handlers are passed in by the parent; this component is a
// pure render layer over the discriminated union. Extracted from
// src/app/signup/page.tsx so unit tests don't have to mock
// wagmi / rainbowkit / next/navigation just to reach the second-
// factor branch.
// ----------------------------------------------------------------------------

export type TotpRequiredState = {
  kind: 'totp_required';
  challengeId: string;
  mode: 'totp' | 'recovery';
  submitting: boolean;
  error: string | null;
  lockedUntil: number | null;
  terminal: 'challenge_invalid' | 'eoa_drift' | null;
};

/// Format an ISO ms timestamp as MM:SS countdown to NOW. Caps at 0:00.
/// Pure for testability — call sites pass `Date.now()` or a frozen
/// value as `now`.
export function formatLockoutRemaining(
  lockedUntilMs: number,
  now: number,
): string {
  const remaining = Math.max(0, lockedUntilMs - now);
  const totalSec = Math.ceil(remaining / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

export function TotpStep({
  state,
  onSubmit,
  onToggleMode,
  onRestart,
}: {
  state: TotpRequiredState;
  onSubmit: (code: string) => void;
  onToggleMode: () => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state.lockedUntil === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [state.lockedUntil]);

  useEffect(() => {
    setCode('');
  }, [state.mode]);

  if (state.terminal !== null) {
    const message =
      state.terminal === 'eoa_drift'
        ? 'Account state changed. Please sign in again.'
        : 'Sign-in session expired. Please sign in again.';
    return (
      <div className="flex flex-col gap-3 mt-2">
        <p
          role="alert"
          className="mako-label text-center text-[12px] text-mako-red bg-mako-red/10 border-2 border-mako-red p-3 rounded-xl"
        >
          {message}
        </p>
        <button
          type="button"
          onClick={onRestart}
          className="mako-button mako-button--action mako-label"
        >
          RESTART SIGN-IN
        </button>
      </div>
    );
  }

  if (state.lockedUntil !== null) {
    return (
      <div className="flex flex-col gap-3 mt-2">
        <div
          role="status"
          aria-live="polite"
          className="mako-label text-center text-[12px] text-mako-red bg-mako-red/10 border-2 border-mako-red p-3 rounded-xl"
        >
          <span className="block mako-label text-[11px] mb-1">LOCKED</span>
          <span>
            Too many failed attempts. Try again in{' '}
            <span className="mako-mono">
              {formatLockoutRemaining(state.lockedUntil, now)}
            </span>
            .
          </span>
        </div>
      </div>
    );
  }

  const inputId =
    state.mode === 'totp' ? 'totp-signin-code' : 'totp-signin-recovery';
  const inputLabel =
    state.mode === 'totp' ? '6-DIGIT CODE' : 'RECOVERY CODE';
  const inputPlaceholder =
    state.mode === 'totp' ? '••••••' : 'XXXX-XXXX-XXXX';
  const inputProps =
    state.mode === 'totp'
      ? {
          inputMode: 'numeric' as const,
          pattern: '[0-9]*',
          maxLength: 6,
          autoComplete: 'one-time-code',
        }
      : {
          inputMode: 'text' as const,
          maxLength: 32,
          autoComplete: 'off' as const,
        };

  return (
    <div className="flex flex-col gap-2 mt-2">
      <label
        className="mako-label text-[10px] text-ink"
        htmlFor={inputId}
      >
        {inputLabel}
      </label>
      <input
        id={inputId}
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={inputPlaceholder}
        disabled={state.submitting}
        className="mako-input mako-mono text-lg bg-white tracking-widest text-center"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(code);
          }
        }}
        {...inputProps}
      />
      {state.error !== null && (
        <p
          role="alert"
          className="mako-body text-xs font-medium text-mako-red"
        >
          {state.error}
        </p>
      )}
      <button
        type="button"
        onClick={() => onSubmit(code)}
        disabled={state.submitting}
        className="mako-button mako-button--action mako-label"
      >
        {state.submitting
          ? 'VERIFYING…'
          : state.mode === 'totp'
            ? 'VERIFY CODE'
            : 'USE RECOVERY CODE'}
      </button>
      <button
        type="button"
        onClick={onToggleMode}
        disabled={state.submitting}
        className="mako-label text-[11px] text-muted underline underline-offset-2 hover:text-ink mt-1"
      >
        {state.mode === 'totp'
          ? 'Lost your authenticator? Use a recovery code'
          : 'Back to authenticator code'}
      </button>
    </div>
  );
}
