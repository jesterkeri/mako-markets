'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useDisconnect, useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';

import { getMagic } from '@/lib/magic-browser';
import {
  addRecentEmail,
  getRecentEmails,
  removeRecentEmail,
} from '@/lib/recent-emails';
import { USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';
import { ThemeToggle } from '@/components/ThemeToggle';

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
  /// User passed Magic OTP but their account has TOTP enabled. The
  /// auth route returned `{ ok: true, status: 'totp_required',
  /// challengeId }` instead of issuing a session. Phase 1G Group 5
  /// will wire the second-factor step UI and consume the
  /// challengeId via /api/user/auth/totp; until then we stop the
  /// flow here with an explicit blocking message rather than silently
  /// routing the user home unauthed (where they'd see a SIGN IN CTA
  /// despite having just entered their OTP).
  | { kind: 'totp_unsupported'; challengeId: string }
  | { kind: 'error'; message: string };

type AuthSuccessBody = { ok: true } & AuthedUser;
type TotpRequiredBody = { ok: true; status: 'totp_required'; challengeId: string };

/// Tiny child component used to fire `router.push('/')` legally inside
/// the ConnectButton.Custom render-prop. Render-props can't host hooks
/// directly, so we render this component when the conditions to
/// redirect are met and let its useEffect do the navigation. Returns
/// null so it doesn't perturb layout.
function WalletConnectRedirectGate({
  enabled,
  onRedirect,
}: {
  enabled: boolean;
  onRedirect: () => void;
}) {
  useEffect(() => {
    if (enabled) onRedirect();
  }, [enabled, onRedirect]);
  return null;
}

export default function SignupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { disconnect } = useDisconnect();
  // useAccount() is called for its subscription side-effect — the
  // component re-renders when wagmi's account state changes, which
  // re-runs the ConnectButton.Custom render-prop's connected check.
  // We don't read `address` here; redirect logic is intent-based and
  // sources its truth from the render-prop, not this hook (see
  // walletConnectIntentRef below).
  useAccount();

  // Wallet redirect is gated by EXPLICIT user intent on this page,
  // not on a state-transition guess. Why this matters (Codex review,
  // 2026-05-03):
  //
  //   The previous transition-detector approach (`prevConnectedRef`
  //   watching `useAccount().address`) had two failure modes:
  //
  //   1. wagmi rehydration race. On first render `useAccount()` is
  //      undefined even when localStorage has a cached wallet. Then
  //      wagmi rehydrates and address flips to truthy. The detector
  //      fired this as "transition undefined → defined" and bounced
  //      the user off /signup before they could act.
  //   2. State desync. `ConnectButton.Custom`'s render-prop computes
  //      `connected = ready && account && chain`, drawing from
  //      RainbowKit/wagmi's connector view. Outer `useAccount().address`
  //      reads a different slice of the same store. They can disagree
  //      under contention (extension collisions, partial rehydration).
  //      When render-prop says connected but `useAccount()` doesn't,
  //      the page rendered the disabled CONNECTING state forever
  //      because the redirect effect never fired.
  //
  // Fix: track an EXPLICIT intent ref that flips true when the user
  // clicks CONNECT A WALLET on this page. Redirect fires from the
  // SAME state source that produces the connected render branch
  // (the render-prop's `connected`), via a child component's
  // useEffect. Stale-connected mounts without intent get a real
  // fallback UI ("CONTINUE WITH WALLET" / "USE A DIFFERENT WALLET")
  // instead of a stuck disabled button.
  const walletConnectIntentRef = useRef(false);
  const completeWalletConnectRedirect = useCallback(() => {
    walletConnectIntentRef.current = false;
    router.replace('/');
  }, [router]);

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
      // The 200 response can be one of two shapes: bucket-A session
      // success or `{ ok, status: 'totp_required', challengeId }` for
      // a TOTP-enabled user. Parse the body BEFORE any success side
      // effects (wallet disconnect, recent-email store, cache write,
      // navigation). Routing home on a totp_required would land the
      // user unauthed at the SIGN IN CTA — they'd think their OTP
      // failed silently.
      let body: Partial<AuthSuccessBody> | Partial<TotpRequiredBody> | null = null;
      try {
        body = (await res.json()) as
          | Partial<AuthSuccessBody>
          | Partial<TotpRequiredBody>;
      } catch {
        // Body parse failure on a 2xx response is unexpected. Treat
        // it as a transient retry case rather than a hard error so
        // the user can re-submit without restarting Magic.
        setState({
          kind: 'retry_available',
          didToken,
          message:
            'Unexpected response from sign-in. The code is still valid; please retry.',
        });
        return;
      }

      if (body && (body as TotpRequiredBody).status === 'totp_required') {
        // Phase 1G Group 5 will replace this branch with the second-
        // factor step UI. Until then, surface an explicit blocking
        // message rather than routing the user home unauthed. The
        // challenge stays valid for ~5 minutes server-side; the user
        // can refresh and start over.
        const challengeId = (body as TotpRequiredBody).challengeId ?? '';
        setState({ kind: 'totp_unsupported', challengeId });
        return;
      }

      // Bucket-A session success. Auto-disconnect any RainbowKit
      // wallet on Magic sign-in. The two auth methods are mutually
      // exclusive by policy: a Magic-signed-in user should NOT also
      // have an external wallet connected, because that ambiguates
      // which key signs the next transaction and clutters the UI
      // with a wallet chip the user didn't ask for. Account transfer
      // between Magic and external wallets is a deliberate Phase 5+
      // feature, not a side-effect of being signed in twice.
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
      // useUser uses refetchOnMount: 'always'. The auth route's bucket-A
      // success envelope is `{ ok, authed, ...WireUser, lastSignInAt,
      // nextEmailChangeAvailableAt }` (see src/lib/users-wire.ts). The
      // React Query cache shape is AuthedUser — `ok` is a route envelope
      // flag, not part of the canonical user shape — so we strip it
      // before writing. The same destructure pattern applies to any
      // future bucket-A response the signup flow consumes (e.g. the
      // /api/user/auth/totp success path Group 5 will wire up).
      const authedBody = body as Partial<AuthSuccessBody>;
      if (authedBody && authedBody.authed === true) {
        const { ok: _ok, ...authedUser } = authedBody as AuthSuccessBody;
        void _ok;
        queryClient.setQueryData(
          USER_QUERY_KEY,
          authedUser satisfies AuthedUser,
        );
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
    // Clear any wallet-connect intent before the email path runs.
    // Avoids a stale wallet intent racing the email flow's own
    // redirect (e.g., user clicked CONNECT A WALLET, then changed
    // their mind and used email instead).
    walletConnectIntentRef.current = false;
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
    <main className="flex min-h-screen bg-chrome text-chrome-fg relative selection:bg-mako-red selection:text-white">
      {/* Theme Toggle in top right */}
      <div className="absolute top-6 right-6 lg:top-8 lg:right-8 z-50">
        <ThemeToggle />
      </div>

      {/* Left Column: Brand Hero (hidden on small screens) */}
      <div 
        className="hidden lg:flex flex-1 flex-col justify-between border-r-4 border-ink bg-signal p-12 relative overflow-hidden"
        style={{
          backgroundImage: `radial-gradient(rgba(0,0,0,0.1) 2px, transparent 2px)`,
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0'
        }}
      >
        {/* Artistic Background Shapes (Bauhaus / Neobrutalist Vibe) */}
        <div className="absolute -top-32 -right-32 w-[30rem] h-[30rem] bg-mako-red border-4 border-ink rounded-full opacity-30 mix-blend-multiply pointer-events-none"></div>
        <div className="absolute -bottom-20 -left-10 w-96 h-96 bg-paper border-4 border-ink opacity-50 mix-blend-overlay rotate-[15deg] pointer-events-none"></div>
        {/* Architectural Corner Crosshairs */}
        <div className="absolute top-12 left-12 w-6 h-6 border-l-4 border-t-4 border-ink pointer-events-none opacity-50 z-20"></div>
        <div className="absolute top-12 right-12 w-6 h-6 border-r-4 border-t-4 border-ink pointer-events-none opacity-50 z-20"></div>
        <div className="absolute bottom-12 left-12 w-6 h-6 border-l-4 border-b-4 border-ink pointer-events-none opacity-50 z-20"></div>
        <div className="absolute bottom-12 right-12 w-6 h-6 border-r-4 border-b-4 border-ink pointer-events-none opacity-50 z-20"></div>

        {/* Massive background typography — outlined and tilted */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col justify-center opacity-10 pointer-events-none select-none -rotate-[10deg] w-[150%]">
          <div className="font-display font-black text-[18vw] leading-[0.75] whitespace-nowrap text-transparent [-webkit-text-stroke:4px_#000] text-center">
            PREDICT
          </div>
          <div className="font-display font-black text-[18vw] leading-[0.75] whitespace-nowrap text-ink text-center translate-x-24">
            TRADE
          </div>
          <div className="font-display font-black text-[18vw] leading-[0.75] whitespace-nowrap text-transparent [-webkit-text-stroke:4px_#000] text-center -translate-x-12">
            PROFIT
          </div>
        </div>

        <div className="relative z-10 pt-12 pb-12">
          <h1 className="font-display text-6xl xl:text-[7rem] font-black tracking-tighter text-ink leading-[0.85]">
            MAKO<br />
            MARKET
          </h1>
          
          <div className="mt-12 bg-white border-4 border-ink p-4 px-6 shadow-[8px_8px_0_0_#000000] rotate-3 w-fit">
            <p className="text-xl xl:text-2xl font-black font-display uppercase tracking-widest text-ink leading-tight max-w-sm">
              The fastest prediction markets on Monad.
            </p>
          </div>
        </div>
      </div>

      {/* Right Column: Auth Form */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-12 relative bg-transparent w-full">
        
        <div className="flex w-full max-w-md flex-col items-center lg:items-stretch">
          
          {/* Mobile Header */}
          <div className="lg:hidden mb-10 flex flex-col items-center text-center">
            <div className="font-display text-5xl sm:text-6xl font-black tracking-tighter text-chrome-fg flex flex-col leading-[0.85]">
              <span>MAKO</span>
              <span>MARKET</span>
            </div>
            <div className="mt-6 mako-sticker mako-sticker--signal scale-90 -rotate-2">
              MONAD TESTNET
            </div>
          </div>

          <div className="relative z-10 w-full bg-paper border-2 border-ink rounded-xl p-6 sm:p-8 flex flex-col gap-8">
            
            {/* Recent-emails picker. */}
            {recentEmails && recentEmails.length > 0 && state.kind === 'idle' && (
              <div className="flex flex-col gap-3 pb-6 border-b border-ink/10">
                <p className="mako-label text-[10px] text-muted uppercase">
                  SIGN BACK IN
                </p>
                <div className="flex flex-col gap-3">
                  {recentEmails.map((recent) => (
                    <div key={recent} className="flex items-stretch gap-2">
                      <button
                        type="button"
                        onClick={() => setEmail(recent)}
                        className="flex-1 rounded-xl border-2 border-ink bg-transparent px-4 py-3 mako-body font-bold text-ink text-left hover:bg-ink/5 transition-colors truncate"
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
                        className="w-12 flex items-center justify-center border-2 border-ink rounded-xl bg-transparent text-ink hover:bg-mako-red hover:text-white hover:border-mako-red transition-colors shrink-0"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Email Path */}
            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label className="mako-label text-[10px] text-muted uppercase" htmlFor="email">
                  {recentEmails && recentEmails.length > 0 ? 'OR USE A DIFFERENT EMAIL' : 'EMAIL ADDRESS'}
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
                  className="w-full rounded-xl border-2 border-ink bg-transparent px-4 py-3 mako-body font-bold text-ink placeholder:text-subtle focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink disabled:opacity-50 transition-colors"
                />
              </div>

              <button
                type="submit"
                disabled={isBusy || isRetryAvailable || !email}
                className="w-full rounded-xl border-2 border-transparent bg-ink text-paper px-4 py-3 font-display font-black tracking-widest uppercase transition-opacity hover:opacity-80 disabled:cursor-not-allowed"
              >
                {buttonLabel}
              </button>

              {isRetryAvailable && (
                <div className="flex flex-col gap-3 mt-2 bg-ink/5 p-4 rounded-xl border-2 border-ink border-dashed">
                  <p
                    role="status"
                    className="mako-label text-center text-[12px] text-ink"
                  >
                    {state.message}
                  </p>
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="w-full rounded-xl border-2 border-ink bg-transparent text-ink px-4 py-3 font-display font-black tracking-widest uppercase transition-colors hover:bg-ink/5"
                  >
                    RETRY VERIFICATION
                  </button>
                  <button
                    type="button"
                    onClick={handleUseDifferentEmail}
                    className="mako-label text-center text-[10px] text-muted underline underline-offset-2 hover:text-ink mt-2"
                  >
                    Use a different email
                  </button>
                </div>
              )}

              {state.kind === 'error' && (
                <p
                  role="alert"
                  className="mako-label text-center text-[12px] text-mako-red bg-mako-red/10 border-2 border-mako-red p-3 rounded-xl mt-2"
                >
                  {state.message}
                </p>
              )}

              {state.kind === 'totp_unsupported' && (
                <p
                  role="alert"
                  className="mako-label text-center text-[12px] text-mako-red bg-mako-red/10 border-2 border-mako-red p-3 rounded-xl mt-2"
                >
                  Two-factor sign-in isn&apos;t available yet. Please try again
                  shortly, or contact support.
                </p>
              )}
            </form>

            {/* Divider */}
            <div className="flex w-full items-center gap-4">
              <div className="h-px bg-ink/20 flex-1"></div>
              <p className="mako-label text-[10px] text-muted uppercase">OR</p>
              <div className="h-px bg-ink/20 flex-1"></div>
            </div>

            {/* Wallet Path */}
            <ConnectButton.Custom>
              {({
                account,
                chain,
                openChainModal,
                openConnectModal,
                mounted,
              }) => {
                const ready = mounted;
                const connected = ready && account && chain;

                if (!ready) {
                  return (
                    <button 
                      disabled 
                      className="w-full rounded-xl border-2 border-ink bg-transparent px-4 py-3 font-display font-black tracking-widest uppercase opacity-50 cursor-not-allowed"
                    >
                      LOADING...
                    </button>
                  );
                }

                if (!connected) {
                  return (
                    <button
                      onClick={() => {
                        // Mark intent BEFORE opening the modal so the
                        // post-connect render branch can distinguish
                        // "user just connected on this page → redirect"
                        // from "user already had a connection cached
                        // before they got here → don't redirect".
                        walletConnectIntentRef.current = true;
                        openConnectModal();
                      }}
                      type="button"
                      className="w-full rounded-xl border-2 border-ink bg-transparent text-ink px-4 py-3 font-display font-black tracking-widest uppercase transition-colors hover:bg-ink/5"
                    >
                      CONNECT A WALLET
                    </button>
                  );
                }

                if (chain.unsupported) {
                  return (
                    <button
                      onClick={openChainModal}
                      type="button"
                      className="w-full rounded-xl border-2 border-mako-red bg-mako-red text-white px-4 py-3 font-display font-black tracking-widest uppercase transition-colors hover:opacity-80"
                    >
                      WRONG NETWORK
                    </button>
                  );
                }

                // Connected + on the right chain. Two sub-cases:
                //
                //   (a) The user JUST clicked CONNECT A WALLET on this
                //       page — intent ref is true. Render the
                //       CONNECTING transient state and let
                //       WalletConnectRedirectGate fire the redirect via
                //       its own useEffect. The gate sources truth from
                //       the SAME render-prop state that produced this
                //       branch, so no state-source desync window
                //       (the bug we're fixing).
                //
                //   (b) The user landed here with a wallet ALREADY
                //       connected (cached in localStorage from a prior
                //       session). Intent is false. Show a real
                //       fallback UI instead of an infinite disabled
                //       button — they can either continue with the
                //       cached wallet (CONTINUE) or disconnect to
                //       switch (USE A DIFFERENT WALLET).
                if (walletConnectIntentRef.current) {
                  return (
                    <>
                      <WalletConnectRedirectGate
                        enabled
                        onRedirect={completeWalletConnectRedirect}
                      />
                      <div className="flex flex-col gap-2">
                        <button
                          type="button"
                          disabled
                          className="w-full rounded-xl border-2 border-ink bg-transparent text-ink px-4 py-3 font-display font-black tracking-widest uppercase opacity-50 cursor-wait"
                        >
                          CONNECTING...
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            walletConnectIntentRef.current = false;
                            disconnect();
                          }}
                          className="mako-label text-[10px] text-muted underline underline-offset-2 hover:text-ink self-center"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  );
                }

                // Stale-cached connection without intent. Give the
                // user a real choice instead of a stuck spinner.
                return (
                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => router.replace('/')}
                      className="w-full rounded-xl border-2 border-ink bg-ink text-paper px-4 py-3 font-display font-black tracking-widest uppercase transition-colors hover:opacity-90"
                    >
                      CONTINUE WITH WALLET
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        walletConnectIntentRef.current = false;
                        disconnect();
                      }}
                      className="w-full rounded-xl border-2 border-ink bg-transparent text-ink px-4 py-3 font-display font-black tracking-widest uppercase transition-colors hover:bg-ink/5"
                    >
                      USE A DIFFERENT WALLET
                    </button>
                  </div>
                );
              }}
            </ConnectButton.Custom>
          </div>
        </div>
      </div>
    </main>
  );
}
