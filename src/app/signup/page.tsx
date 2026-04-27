'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { getMagic } from '@/lib/magic-browser';

// ----------------------------------------------------------------------------
// /signup — Phase 1A email auth entry point.
//
// User journey:
//   1. Type email, submit.
//   2. magic.auth.loginWithEmailOTP({ email, lifespan }) opens Magic's hosted
//      OTP modal; the user enters the code and the call resolves with a DID
//      token that's only valid for `lifespan` seconds.
//   3. POST { didToken } to /api/user/auth. The server validates the token,
//      upserts the users + user_safes rows, creates a session, sets the cookie.
//   4. On 200, redirect to /.
//
// DID lifespan is reduced from Magic's 900s default to 120s to narrow the
// replay window. The user just needs the network round-trip to /api/user/auth
// to land within that window. A stronger fix is to track consumed DID tids
// server-side via `magic.token.decode(didToken)[1].tid` (admin SDK 2.8.2)
// against a `consumed_dids` table — that lands with Phase 1B.
//
// Retry behavior:
//   - 4xx from server (bad_token, not_allowlisted, identity_conflict): the
//     DID is unusable / the situation is terminal. Show error, fresh OTP
//     required.
//   - 5xx or network error: the DID is still valid for the rest of its
//     lifespan. Cache it in state and offer a "Retry verification" button so
//     the user doesn't have to redo OTP for a transient blip.
//
// The Connect-Wallet path is intentionally absent in Phase 1A — comes back in
// Phase 1F. The visual style mirrors `staged-gemini/auth/SignInScreen.tsx` so
// the page slots into the neobrutalist system already integrated into the app.
// ----------------------------------------------------------------------------

const DID_LIFESPAN_SEC = 120;

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'awaiting_otp' }
  | { kind: 'verifying'; didToken: string }
  | { kind: 'retry_available'; didToken: string; message: string }
  | { kind: 'error'; message: string };

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  /// Synchronous re-entry guard. React state updates queue across renders, so
  /// two rapid clicks on the retry button could both observe `state.kind ===
  /// 'retry_available'` and fire two `postDidToken` calls — duplicate session
  /// rows. The ref flips before the async call and resets after, blocking
  /// the second click from progressing.
  const inFlightRef = useRef(false);

  async function postDidToken(didToken: string) {
    setState({ kind: 'verifying', didToken });
    let res: Response;
    try {
      res = await fetch('/api/user/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ didToken }),
      });
    } catch {
      setState({
        kind: 'retry_available',
        didToken,
        message: 'Network error. The sign-in code is still valid; please retry.',
      });
      return;
    }

    if (res.ok) {
      router.replace('/');
      router.refresh();
      return;
    }

    if (res.status >= 500) {
      let serverMessage = 'Server error. The sign-in code is still valid; please retry.';
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error === 'magic_metadata_failed') {
          serverMessage = 'Magic is temporarily unreachable. Please retry.';
        }
      } catch {
        // fall through with default message
      }
      setState({ kind: 'retry_available', didToken, message: serverMessage });
      return;
    }

    // 4xx — terminal for this DID. Fresh OTP required.
    let serverMessage = 'Sign-in failed. Please try again.';
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === 'not_allowlisted') {
        serverMessage = 'This email is not on the beta allowlist yet.';
      } else if (body.error === 'identity_conflict') {
        serverMessage = 'Identity mismatch detected. Please contact support.';
      } else if (body.error === 'bad_token') {
        serverMessage = 'Sign-in token rejected. Please try again.';
      } else if (body.error === 'cross_origin') {
        serverMessage = 'Request blocked by security check. Please refresh and retry.';
      }
    } catch {
      // fall through with default message
    }
    setState({ kind: 'error', message: serverMessage });
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !email ||
      inFlightRef.current ||
      state.kind === 'awaiting_otp' ||
      state.kind === 'verifying'
    ) {
      return;
    }

    inFlightRef.current = true;
    setState({ kind: 'awaiting_otp' });
    let didToken: string | null;
    try {
      const magic = await getMagic();
      didToken = await magic.auth.loginWithEmailOTP({
        email,
        lifespan: DID_LIFESPAN_SEC,
      });
    } catch (err) {
      inFlightRef.current = false;
      const message = err instanceof Error ? err.message : 'Sign-in cancelled';
      setState({ kind: 'error', message });
      return;
    }

    if (!didToken) {
      inFlightRef.current = false;
      setState({ kind: 'error', message: 'Magic returned no token. Please try again.' });
      return;
    }

    try {
      await postDidToken(didToken);
    } finally {
      inFlightRef.current = false;
    }
  }

  async function handleRetry() {
    if (inFlightRef.current) return;
    if (state.kind !== 'retry_available') return;
    inFlightRef.current = true;
    try {
      await postDidToken(state.didToken);
    } finally {
      inFlightRef.current = false;
    }
  }

  /// Drop the cached DID and reset to the email form. Used when the user
  /// realizes they typed the wrong address but already received an OTP for
  /// it — without this, the retry-available state would only let them
  /// re-attempt verification of the wrong email.
  function handleUseDifferentEmail() {
    if (inFlightRef.current) return;
    setEmail('');
    setState({ kind: 'idle' });
  }

  const isBusy = state.kind === 'awaiting_otp' || state.kind === 'verifying';
  const isRetryAvailable = state.kind === 'retry_available';
  const buttonLabel =
    state.kind === 'awaiting_otp'
      ? 'CHECK YOUR EMAIL...'
      : state.kind === 'verifying'
        ? 'SIGNING YOU IN...'
        : 'SIGN IN WITH EMAIL';

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-paper px-4">
      <div className="flex w-full max-w-sm flex-col items-center">
        <div className="mb-12">
          <div className="text-ink text-center font-display text-6xl font-black tracking-tighter">
            MAKO
          </div>
        </div>

        <form onSubmit={handleEmailSubmit} className="relative z-10 flex w-full flex-col gap-4">
          <label className="sr-only" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            disabled={isBusy || isRetryAvailable}
            required
            autoComplete="email"
            className="w-full rounded-xl border-2 border-ink bg-paper px-4 py-3 mako-body text-ink shadow-[2px_2px_0_0_#000000] placeholder:text-subtle focus:border-ink focus:outline-none focus:ring-2 focus:ring-signal disabled:opacity-50"
          />

          <button
            type="submit"
            disabled={isBusy || isRetryAvailable || !email}
            className="mako-button mako-button--signal w-full disabled:cursor-not-allowed disabled:opacity-75"
          >
            {buttonLabel}
          </button>

          {isRetryAvailable && (
            <>
              <p
                role="status"
                className="mako-label text-center text-[12px] text-ink"
              >
                {state.message}
              </p>
              <button
                type="button"
                onClick={handleRetry}
                className="mako-button mako-button--signal w-full"
              >
                RETRY VERIFICATION
              </button>
              <button
                type="button"
                onClick={handleUseDifferentEmail}
                className="mako-label text-center text-[10px] text-muted underline underline-offset-2 hover:text-ink"
              >
                Use a different email
              </button>
            </>
          )}

          {state.kind === 'error' && (
            <p
              role="alert"
              className="mako-label text-center text-[12px] text-ink"
            >
              {state.message}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
