'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useDisconnect, useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';

import { useLogin, usePrivy } from '@privy-io/react-auth';

import { PRIVY_APP_ID } from '@/components/PrivyAuth';
import {
  addRecentEmail,
  getRecentEmails,
  removeRecentEmail,
} from '@/lib/recent-emails';
import { USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TotpStep, mapTotpResponse } from '@/components/signup/TotpStep';

// ----------------------------------------------------------------------------
// /signup: the sign-in page, email (Privy) and wallet (SIWE) side by side.
//
// Email journey (Privy since 2026-09-29, when Joshua moved everyone off Magic):
//   1. Type the email, submit.
//   2. Privy's login modal opens pre-filled with it. Privy verifies the emailed code and creates the user's
//      embedded wallet if they have none. A Privy session left over from an earlier visit is ended first,
//      so the email is proven now.
//   3. POST { privyAccessToken } to /api/user/auth. The server verifies the token, reads the email and the
//      embedded wallets from Privy's own API (never from the browser), upserts the users + user_safes rows,
//      and either creates a session or, for a TOTP account, returns a challenge for the second factor.
//   4. On success, redirect to /.
//
// Retry behavior:
//   - 4xx (bad_token, not_allowlisted, identity_conflict, ...): terminal for this token. Show the error; the
//     user starts again from the email. A failure reaching Privy's API during verification also lands here,
//     because the route answers it as bad_token.
//   - 5xx or a network error: keep the token in state and offer RETRY VERIFICATION, so a transient blip does
//     not cost a new email code. Privy's access token expires on Privy's schedule; a retry after that is
//     refused as bad_token and the user starts again.
//
// The access token is a bearer credential until it expires. The route accepts it only from this origin
// (checkSameOrigin), and a TOTP account still needs its second factor before any session.
//
// The wallet path (RainbowKit + SIWE) always renders, whether or not Privy is configured. The visual style
// mirrors `staged-gemini/auth/SignInScreen.tsx` so the page slots into the neobrutalist system.
// ----------------------------------------------------------------------------


type SubmitState =
  | { kind: 'idle' }
  | { kind: 'awaiting_otp' }
  | { kind: 'verifying'; authToken: string }
  | { kind: 'retry_available'; authToken: string; message: string }
  /// Email code verified, user has TOTP enabled. Server issued a
  /// challengeId; this is the second-factor step. `mode` flips
  /// between 6-digit TOTP entry and recovery-code entry. `submitting`
  /// gates the action button. `error` surfaces an inline retryable
  /// failure ('That code is wrong'). `lockedUntil` is the ISO ms
  /// timestamp at which the 15-min lockout elapses — non-null while
  /// locked, cleared when the live countdown reaches zero.
  /// `terminal` flips to a non-null value when the challenge can't
  /// be retried in place: `challenge_invalid` (expired / consumed)
  /// or `eoa_drift` (server-side defensive guard tripped). Both
  /// require restarting from email.
  | {
      kind: 'totp_required';
      challengeId: string;
      mode: 'totp' | 'recovery';
      submitting: boolean;
      error: string | null;
      lockedUntil: number | null;
      terminal: 'challenge_invalid' | 'eoa_drift' | null;
    }
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


/// Privy's hooks need its provider, which exists only when NEXT_PUBLIC_PRIVY_APP_ID is set. They live in this
/// child, mounted only then, so the rest of the page (the wallet sign-in included) always renders; without
/// Privy, an email submit says sign-in is not configured (adversary pass, 2026-09-29).
function PrivyEmailLogin(props: {
  register: (start: ((email: string) => Promise<void>) | null) => void;
  onToken: (token: string | null) => void;
  onFailure: (message: string) => void;
}) {
  const { register, onToken, onFailure } = props;
  const { authenticated, getAccessToken, logout } = usePrivy();
  /// Marks a login THIS page started, so a Privy session restored on page load never posts a token by itself.
  const pendingRef = useRef(false);
  const { login } = useLogin({
    onComplete: async () => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      onToken(await getAccessToken());
    },
    onError: (err) => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      onFailure(err === 'exited_auth_flow' ? 'Sign-in cancelled' : 'Sign-in failed. Please try again.');
    },
  });
  useEffect(() => {
    register(async (email: string) => {
      // A Privy session left over from an earlier visit would skip the email code; end it so the email is
      // proven now, and so the account signed in is the one typed here.
      if (authenticated) {
        try {
          await logout();
        } catch (e) {
          console.warn('Privy logout before sign-in failed', e);
        }
      }
      pendingRef.current = true;
      login({ loginMethods: ['email'], prefill: { type: 'email', value: email } });
    });
    return () => register(null);
  }, [authenticated, login, logout, register]);
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
  /// 'retry_available'` and fire two `postAuthToken` calls — duplicate session
  /// rows. The ref flips before the async call and resets after, blocking
  /// the second click from progressing.
  const inFlightRef = useRef(false);

  /// Privy's email login, registered by <PrivyEmailLogin/> when Privy is configured; null otherwise.
  const startEmailLoginRef = useRef<((email: string) => Promise<void>) | null>(null);
  const registerEmailLogin = useCallback((start: ((email: string) => Promise<void>) | null) => {
    startEmailLoginRef.current = start;
  }, []);
  const handlePrivyToken = useCallback(async (token: string | null) => {
    if (!token) {
      inFlightRef.current = false;
      setState({ kind: 'error', message: 'Sign-in returned no token. Please try again.' });
      return;
    }
    try {
      await postAuthToken(token);
    } finally {
      inFlightRef.current = false;
    }
    // postAuthToken is recreated each render; this handler reads the latest through the child's re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handlePrivyFailure = useCallback((message: string) => {
    inFlightRef.current = false;
    setState({ kind: 'error', message });
  }, []);

  async function postAuthToken(authToken: string) {
    setState({ kind: 'verifying', authToken });
    let res: Response;
    try {
      res = await fetch('/api/user/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ privyAccessToken: authToken }),
      });
    } catch {
      setState({
        kind: 'retry_available',
        authToken,
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
        // the user can re-submit without a new email code.
        setState({
          kind: 'retry_available',
          authToken,
          message:
            'Unexpected response from sign-in. The code is still valid; please retry.',
        });
        return;
      }

      if (body && (body as TotpRequiredBody).status === 'totp_required') {
        // Phase 1G Group 5B: transition to second-factor step. Server
        // issued a challengeId valid for ~5 minutes. UI presents the
        // 6-digit input by default (most common path); recovery toggle
        // is a button that swaps mode without losing the challengeId.
        const challengeId = (body as TotpRequiredBody).challengeId ?? '';
        setState({
          kind: 'totp_required',
          challengeId,
          mode: 'totp',
          submitting: false,
          error: null,
          lockedUntil: null,
          terminal: null,
        });
        return;
      }

      // Bucket-A session success. Auto-disconnect any RainbowKit
      // wallet on email sign-in. The two auth methods are mutually
      // exclusive by policy: an email-signed-in user should NOT also
      // have an external wallet connected, because that ambiguates
      // which key signs the next transaction and clutters the UI
      // with a wallet chip the user didn't ask for. Account transfer
      // between email and external wallets is a deliberate Phase 5+
      // feature, not a side-effect of being signed in twice.
      try {
        disconnect();
      } catch (e) {
        // Best-effort — disconnect on a non-connected state is a no-op,
        // and a real failure here doesn't block sign-in. Log so a
        // wagmi regression shows up.
        console.warn('Wallet disconnect on email sign-in failed', e);
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
      // The Privy access token is still valid for a while, so the same token can be retried.
      setState({ kind: 'retry_available', authToken, message: 'Server error. Your sign-in is still valid; please retry.' });
      return;
    }

    // 4xx: terminal for this token. The user starts again from the email.
    let serverMessage = 'Sign-in failed. Please try again.';
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === 'not_allowlisted') {
        serverMessage = 'This email is not on the beta allowlist yet.';
      } else if (body.error === 'identity_conflict') {
        serverMessage = 'Identity mismatch detected. Please contact support.';
      } else if (body.error === 'bad_token') {
        serverMessage = 'Sign-in token rejected. Please try again.';
      } else if (body.error === 'no_email' || body.error === 'no_embedded_wallet') {
        serverMessage = 'Your sign-in did not finish setting up. Please try again.';
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
    const start = startEmailLoginRef.current;
    if (!start) {
      inFlightRef.current = false;
      setState({ kind: 'error', message: 'Email sign-in is not configured on this deployment. You can still connect a wallet.' });
      return;
    }
    setState({ kind: 'awaiting_otp' });
    await start(email);
  }

  async function handleRetry() {
    if (inFlightRef.current) return;
    if (state.kind !== 'retry_available') return;
    inFlightRef.current = true;
    try {
      await postAuthToken(state.authToken);
    } finally {
      inFlightRef.current = false;
    }
  }

  /// Drop the cached token and reset to the email form. Used when the user
  /// realizes they typed the wrong address but already received an OTP for
  /// it — without this, the retry-available state would only let them
  /// re-attempt verification of the wrong email.
  function handleUseDifferentEmail() {
    if (inFlightRef.current) return;
    setEmail('');
    setState({ kind: 'idle' });
  }

  /// Submit the TOTP / recovery factor for an issued challengeId. Routes
  /// the response through the same bucket-A handling as the email sign-in
  /// success path (cache hydrate → wallet disconnect → addRecentEmail →
  /// router.replace('/')). Error mapping per /api/user/auth/totp:
  ///   - 200            → success, identical to /api/user/auth success
  ///   - 401 totp_failed → inline error, retryable in place
  ///   - 401 challenge_invalid / eoa_drift → terminal, restart from email
  ///   - 429 totp_locked + retryAt → switch to lockout countdown view
  ///   - 5xx / network → inline retry-able error
  async function handleSubmitTotp(rawCode: string) {
    if (state.kind !== 'totp_required') return;
    if (state.submitting) return;
    if (state.lockedUntil) return;
    if (state.terminal) return;

    const trimmed = rawCode.trim();
    if (trimmed.length === 0) {
      setState({ ...state, error: state.mode === 'totp'
        ? 'Enter the 6-digit code from your authenticator.'
        : 'Enter a recovery code.' });
      return;
    }

    setState({ ...state, submitting: true, error: null });

    let res: Response;
    try {
      res = await fetch('/api/user/auth/totp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          state.mode === 'totp'
            ? { challengeId: state.challengeId, code: trimmed }
            : { challengeId: state.challengeId, recoveryCode: trimmed },
        ),
      });
    } catch {
      setState({
        ...state,
        submitting: false,
        error: 'Network error. Please retry.',
      });
      return;
    }

    // Read body once. Used both by success (auth payload) and error
    // (discriminator + retryAt) branches.
    let body: Partial<AuthSuccessBody> & { error?: string; retryAt?: string }
      | null = null;
    try {
      body = (await res.json()) as Partial<AuthSuccessBody> & {
        error?: string;
        retryAt?: string;
      };
    } catch {
      // body stays null; mapping treats this as a generic failure on the
      // error branch, and as an unexpected-response failure on the
      // success branch (we need an authed payload to populate the cache).
      if (res.ok) {
        setState({
          ...state,
          submitting: false,
          error: 'Unexpected response. Please retry.',
        });
        return;
      }
    }

    const outcome = mapTotpResponse(state, res.status, body ?? null);
    if (outcome.kind === 'state') {
      setState(outcome.next);
      return;
    }

    // Success path. Mirrors postAuthToken's success branch — wallet
    // disconnect, recent-email cache, query cache pre-populate, route
    // home. Keep this in sync if the email sign-in success path changes.
    try {
      disconnect();
    } catch (e) {
      console.warn('Wallet disconnect on TOTP sign-in failed', e);
    }

    addRecentEmail(email);

    if (body && body.authed === true) {
      const { ok: _ok, ...authedUser } = body as AuthSuccessBody;
      void _ok;
      queryClient.setQueryData(
        USER_QUERY_KEY,
        authedUser satisfies AuthedUser,
      );
    }
    router.replace('/');
  }

  /// Toggle between TOTP code and recovery code modes. Clears any
  /// inline error so a wrong-code message from one mode doesn't bleed
  /// into the other input box.
  function handleToggleTotpMode() {
    if (state.kind !== 'totp_required') return;
    if (state.submitting || state.lockedUntil || state.terminal) return;
    setState({
      ...state,
      mode: state.mode === 'totp' ? 'recovery' : 'totp',
      error: null,
    });
  }

  /// Restart from the email form. Used when challenge_invalid or
  /// eoa_drift makes the current TOTP step un-retryable. Keeps the
  /// email field so the user doesn't have to retype.
  function handleRestartFromTotp() {
    setState({ kind: 'idle' });
  }

  /// Live lockout countdown. While `state.kind === 'totp_required'` and
  /// `lockedUntil` is set, tick once per second; clear lockedUntil
  /// when the timestamp elapses so the input re-enables.
  useEffect(() => {
    if (state.kind !== 'totp_required') return;
    if (state.lockedUntil === null) return;
    const tick = () => {
      setState((prev) => {
        if (prev.kind !== 'totp_required') return prev;
        if (prev.lockedUntil === null) return prev;
        if (Date.now() >= prev.lockedUntil) {
          return { ...prev, lockedUntil: null };
        }
        return { ...prev };
      });
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state.kind, state.kind === 'totp_required' ? state.lockedUntil : null]);

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
      {PRIVY_APP_ID && (
        <PrivyEmailLogin register={registerEmailLogin} onToken={handlePrivyToken} onFailure={handlePrivyFailure} />
      )}
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
          <h1 className="font-display text-[clamp(3.75rem,8vw,7rem)] font-black tracking-tighter text-ink leading-[0.85]">
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

              {state.kind === 'totp_required' && (
                <TotpStep
                  state={state}
                  onSubmit={handleSubmitTotp}
                  onToggleMode={handleToggleTotpMode}
                  onRestart={handleRestartFromTotp}
                />
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
