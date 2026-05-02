'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useDisconnect } from 'wagmi';

import { getMagic } from '@/lib/magic-browser';
import {
  addRecentEmail,
  getRecentEmails,
  removeRecentEmail,
} from '@/lib/recent-emails';
import { USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';

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

type AuthSuccessBody = { ok: true } & AuthedUser;

export default function SignupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { disconnect } = useDisconnect();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  /// Recent emails for the one-tap return picker. Loaded from
  /// localStorage on mount so SSR doesn't try to read browser-only APIs.
  /// `null` is the pre-mount sentinel; treat as "loading" in the UI so
  /// the picker doesn't flicker in then out on hydrate.
  const [recentEmails, setRecentEmails] = useState<string[] | null>(null);
  useEffect(() => {
    setRecentEmails(getRecentEmails());
  }, []);
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
      // Auto-disconnect any RainbowKit wallet on Magic sign-in. The two
      // auth methods are mutually exclusive by policy: a Magic-signed-in
      // user should NOT also have an external wallet connected, because
      // that ambiguates which key signs the next transaction and clutters
      // the UI with a wallet chip the user didn't ask for. Account
      // transfer between Magic and external wallets is a deliberate
      // Phase 5+ feature, not a side-effect of being signed in twice.
      try {
        disconnect();
      } catch (e) {
        // Best-effort — disconnect on a non-connected state is a no-op,
        // and a real failure here doesn't block sign-in. Log so a
        // wagmi regression shows up.
        console.warn('Wallet disconnect on Magic sign-in failed', e);
      }

      // Remember this email for one-tap return on the next visit. Lives
      // in localStorage; convenience-only, not a credential. See
      // src/lib/recent-emails.ts for the threat model.
      addRecentEmail(email);

      // Pre-populate the ['user'] cache before navigating so the home page
      // mounts already authed — no unauthed→authed flash even though
      // useUser uses refetchOnMount: 'always'. The auth route returns the
      // full canonical payload alongside { ok: true }; we strip `ok` and
      // pass through the auth fields verbatim.
      try {
        const body = (await res.json()) as Partial<AuthSuccessBody>;
        if (body && body.authed === true && body.email && body.magicEoa && body.safeAddress) {
          queryClient.setQueryData(USER_QUERY_KEY, {
            authed: true,
            email: body.email,
            magicEoa: body.magicEoa,
            safeAddress: body.safeAddress,
            // First sign-in has no prior session — /api/user/me would
            // also return null. Refetch will replace this on the home
            // page mount per useUser's refetchOnMount: 'always'.
            lastSignInAt: null,
          } satisfies AuthedUser);
        }
      } catch {
        // Body parse failure is non-fatal — the home page will refetch on
        // mount and pick up the live session via /api/user/me. Worst case
        // is a brief skeleton while that happens.
      }
      router.replace('/');
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

        {/* Recent-emails picker. Renders only when there's at least one
            remembered email AND the form is in the idle entry state. The
            click handlers pre-fill the input rather than auto-submit so
            the user explicitly confirms the email they want to sign back
            in as. */}
        {recentEmails && recentEmails.length > 0 && state.kind === 'idle' && (
          <div className="relative z-10 flex w-full flex-col gap-2 mb-4">
            <p className="mako-label text-center text-[10px] text-muted">
              SIGN BACK IN AS
            </p>
            <div className="flex flex-col gap-2">
              {recentEmails.map((recent) => (
                <div key={recent} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEmail(recent)}
                    className="flex-1 rounded-xl border-2 border-ink bg-paper px-4 py-3 mako-body text-ink shadow-brutal-sm text-left hover:bg-surface-elevated transition-colors truncate"
                  >
                    {recent}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeRecentEmail(recent);
                      setRecentEmails(getRecentEmails());
                    }}
                    aria-label={`Forget ${recent}`}
                    className="w-10 h-10 flex items-center justify-center border-2 border-ink rounded-xl text-ink hover:bg-mako-red hover:text-white hover:border-mako-red transition-colors shrink-0"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            <p className="mako-label text-center text-[10px] text-muted mt-2">
              OR ADD A NEW ACCOUNT
            </p>
          </div>
        )}

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
            className="w-full rounded-xl border-2 border-ink bg-paper px-4 py-3 mako-body text-ink shadow-brutal-sm placeholder:text-subtle focus:border-ink focus:outline-none focus:ring-2 focus:ring-signal disabled:opacity-50"
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
