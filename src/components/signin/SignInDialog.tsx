'use client';

import Link from 'next/link';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { QRCodeSVG } from 'qrcode.react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';

import { Logo } from '@/components/Logo';
import { Mascot } from '@/components/Mascot';
import { PRIVY_APP_ID } from '@/components/PrivyAuth';
import { formatLockoutRemaining, type TotpRequiredState } from '@/components/signup/TotpStep';
import { ROUNDS_ADDRESS } from '@/lib/contract';
import { useMarkets } from '@/lib/hooks';
import { CIRCLE_FAUCET_URL } from '@/lib/list-states';
import { openPools } from '@/lib/pool-display';
import { confirmWalletFree, continueGatedSignIn } from '@/lib/privy-gated-signin';
import { submitTotp, type SessionResult } from '@/lib/session-exchange';
import { closeSignIn, useSignInOpen } from '@/lib/sign-in-store';
import { accountAddress, USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';
import { formatAddress } from '@/lib/user-display';
import { signInWithWallet } from '@/lib/wallet-auth-client';

import { PrivyEmailBridge, type EmailAuth } from './PrivyEmailBridge';

// Sign in (14a): a dialog over the current page on desktop, a bottom sheet on mobile. Email first (a 6-digit code
// through Privy), a second factor for accounts that have one, or a wallet instead. The first time an account ever
// signs in it ends on "You're in", which carries the beta notice; a returning account closes straight back to the
// page it was on.

type Step =
  | { kind: 'email'; error: string | null; sending: boolean }
  | { kind: 'code'; error: string | null; verifying: boolean; retryToken: string | null; sentAt: number }
  | { kind: 'totp'; state: TotpRequiredState }
  /// INBOX_GAP_PLAN r18: an authenticator first (secret null while Privy prepares it), then the wallet.
  | { kind: 'enroll'; secret: string | null; authUrl: string | null; code: string; submitting: boolean; error: string | null }
  | { kind: 'wallet_setup'; busy: boolean; error: string | null }
  | { kind: 'wallet'; error: string | null; busy: boolean }
  | { kind: 'done'; user: AuthedUser };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESEND_AFTER_SEC = 60;
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

export function SignInDialog() {
  const open = useSignInOpen();
  return open ? <SignInFlow /> : null;
}

function SignInFlow() {
  const queryClient = useQueryClient();
  const { disconnect } = useDisconnect();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'email', error: null, sending: false });
  const auth = useRef<EmailAuth | null>(null);
  const register = useCallback((a: EmailAuth | null) => {
    auth.current = a;
  }, []);
  const busy =
    (step.kind === 'email' && step.sending) ||
    (step.kind === 'code' && step.verifying) ||
    (step.kind === 'totp' && step.state.submitting) ||
    (step.kind === 'enroll' && step.submitting) ||
    (step.kind === 'wallet_setup' && step.busy) ||
    (step.kind === 'wallet' && step.busy);

  const close = useCallback(() => {
    if (!busy) closeSignIn();
  }, [busy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const signedIn = (user: AuthedUser, firstSignIn: boolean) => {
    queryClient.setQueryData(USER_QUERY_KEY, user);
    if (firstSignIn) setStep({ kind: 'done', user });
    else closeSignIn();
  };

  const settle = (r: SessionResult, token: string) => {
    if (r.kind === 'signed_in') {
      // Email and wallet sessions are exclusive: an email sign-in drops a connected wallet.
      try {
        disconnect();
      } catch {
        // Nothing to disconnect.
      }
      signedIn(r.user, r.firstSignIn);
    } else if (r.kind === 'totp') {
      setStep({ kind: 'totp', state: { kind: 'totp_required', challengeId: r.challengeId, mode: 'totp', submitting: false, error: null, lockedUntil: null, terminal: null } });
    } else if (r.kind === 'retry') {
      // The Privy session is kept: a retry runs the gate again (a fresh token and a fresh proof), not the spent code.
      setStep({ kind: 'code', error: r.message, verifying: false, retryToken: token || 'gate', sentAt: step.kind === 'code' ? step.sentAt : Date.now() });
    } else {
      setStep({ kind: 'code', error: r.message, verifying: false, retryToken: null, sentAt: step.kind === 'code' ? step.sentAt : Date.now() });
    }
  };

  /// One pass of the inbox-takeover gate (src/lib/privy-gated-signin.ts), from the Privy session this dialog proved.
  const runGate = async () => {
    const gate = auth.current?.gate;
    if (!gate) {
      setStep({ kind: 'email', error: 'Email sign-in is not set up on this site right now. You can sign in with a wallet instead.', sending: false });
      return;
    }
    const r = await continueGatedSignIn(gate, window.location.host);
    if (r.kind === 'enroll') {
      setStep({ kind: 'enroll', secret: null, authUrl: null, code: '', submitting: true, error: null });
      try {
        const { secret, authUrl } = await gate.enrollStart();
        setStep({ kind: 'enroll', secret, authUrl, code: '', submitting: false, error: null });
      } catch {
        setStep({ kind: 'enroll', secret: null, authUrl: null, code: '', submitting: false, error: "The authenticator setup couldn't start. Try again." });
      }
      return;
    }
    if (r.kind === 'wallet_setup') {
      setStep({ kind: 'wallet_setup', busy: false, error: null });
      return;
    }
    settle(r.result, 'gate');
  };

  /// [C5] The authenticator first; the wallet only after Privy has recorded it, then the proof and the session.
  const finishEnroll = async () => {
    const gate = auth.current?.gate;
    if (step.kind !== 'enroll' || step.submitting || !gate || !/^\d{6}$/.test(step.code)) return;
    const prev = step;
    setStep({ ...prev, submitting: true, error: null });
    try {
      await gate.enrollFinish(prev.code);
    } catch {
      setStep({ ...prev, code: '', submitting: false, error: 'That code didn’t match. Check the app and enter the current 6-digit code.' });
      return;
    }
    // The server records the enrollment checkpoint before the wallet exists; only its `wallet_required` lets the
    // wallet be created (migration 0014).
    const cp = await confirmWalletFree(gate);
    if (!cp.ok) {
      if (cp.retry) setStep({ kind: 'wallet_setup', busy: false, error: 'Your authenticator is set up, but Mako Market couldn’t finish the next step. Try again.' });
      else await runGate();
      return;
    }
    try {
      await gate.createWallet();
    } catch {
      setStep({ kind: 'wallet_setup', busy: false, error: 'Your authenticator is set up, but the wallet wasn’t created. Try again.' });
      return;
    }
    await runGate();
  };

  /// [H2] Back after an interruption: enrolled, no wallet. A fresh authenticator code, then the wallet.
  const setupWallet = async () => {
    const gate = auth.current?.gate;
    if (step.kind !== 'wallet_setup' || step.busy || !gate) return;
    setStep({ kind: 'wallet_setup', busy: true, error: null });
    try {
      await gate.freshFactor();
    } catch {
      setStep({ kind: 'wallet_setup', busy: false, error: 'The wallet needs a code from your authenticator app. Try again.' });
      return;
    }
    const cp = await confirmWalletFree(gate);
    if (!cp.ok) {
      if (cp.retry) setStep({ kind: 'wallet_setup', busy: false, error: 'Mako Market couldn’t finish setting up your wallet. Try again.' });
      else await runGate();
      return;
    }
    try {
      await gate.createWallet();
    } catch {
      setStep({ kind: 'wallet_setup', busy: false, error: 'The wallet wasn’t created. Try again.' });
      return;
    }
    await runGate();
  };

  const sendCode = async () => {
    if (busy || !EMAIL.test(email.trim())) return;
    if (!auth.current) {
      setStep({ kind: 'email', error: 'Email sign-in is not set up on this site right now. You can sign in with a wallet instead.', sending: false });
      return;
    }
    setStep({ kind: 'email', error: null, sending: true });
    try {
      await auth.current.sendCode(email.trim());
      setCode('');
      setStep({ kind: 'code', error: null, verifying: false, retryToken: null, sentAt: Date.now() });
    } catch {
      setStep({ kind: 'email', error: "The code couldn't be sent. Check the address and try again.", sending: false });
    }
  };

  const verify = async () => {
    if (step.kind !== 'code' || step.verifying) return;
    const sentAt = step.sentAt;
    // A retry after a network or server error reuses the proven token rather than the spent code.
    if (step.retryToken) {
      setStep({ ...step, verifying: true, error: null });
      await runGate();
      return;
    }
    if (!/^\d{6}$/.test(code) || !auth.current) return;
    setStep({ ...step, verifying: true, error: null });
    let token: string | null;
    try {
      token = await auth.current.verify(code);
    } catch {
      setStep({ kind: 'code', error: 'That code didn’t match. Check the latest email and try again.', verifying: false, retryToken: null, sentAt });
      return;
    }
    if (!token) {
      setStep({ kind: 'code', error: 'Sign-in returned no token. Please try again.', verifying: false, retryToken: null, sentAt });
      return;
    }
    await runGate();
  };

  const submit2fa = async (value: string) => {
    if (step.kind !== 'totp') return;
    const s = step.state;
    if (s.submitting || (s.lockedUntil !== null && s.lockedUntil > Date.now()) || s.terminal) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setStep({ kind: 'totp', state: { ...s, error: s.mode === 'totp' ? 'Enter the 6-digit code from your authenticator.' : 'Enter a recovery code.' } });
      return;
    }
    const submitting = { ...s, submitting: true, error: null, lockedUntil: null };
    setStep({ kind: 'totp', state: submitting });
    const r = await submitTotp(submitting, trimmed);
    if (r.kind === 'state') setStep({ kind: 'totp', state: r.next });
    else settle({ kind: 'signed_in', user: r.user, firstSignIn: r.firstSignIn }, '');
  };

  const view: FlowProps = {
    step,
    setStep,
    email,
    setEmail,
    code,
    setCode,
    sendCode,
    verify,
    submit2fa,
    finishEnroll,
    setupWallet,
    signedIn,
    close,
  };
  return (
    <>
      {PRIVY_APP_ID && <PrivyEmailBridge register={register} />}
      <div className="mk-desk">
        <DesktopDialog {...view} />
      </div>
      <div className="mk-mob mk-m">
        <MobileSheet {...view} />
      </div>
    </>
  );
}

type FlowProps = {
  step: Step;
  setStep: (s: Step) => void;
  email: string;
  setEmail: (s: string) => void;
  code: string;
  setCode: (s: string) => void;
  sendCode: () => void;
  verify: () => void;
  submit2fa: (value: string) => void;
  finishEnroll: () => void;
  setupWallet: () => void;
  signedIn: (user: AuthedUser, firstSignIn: boolean) => void;
  close: () => void;
};

// ---------------------------------------------------------------------------------------------------------------
// Layouts

const CLOSE_ICON = 'M7 7l10 10M17 7L7 17';

function DesktopDialog(p: FlowProps) {
  return (
    <>
      <div onClick={p.close} className="mk-scrim" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sign in"
        className="mk-pop"
        style={{ position: 'fixed', top: 84, left: '50%', marginLeft: -400, width: 800, zIndex: 61, display: 'grid', gridTemplateColumns: '360px 1fr', borderRadius: 20, background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)', boxShadow: 'var(--edge), inset 0 0 0 1px var(--line), 0 40px 100px rgba(0,0,0,0.55)' }}
      >
        <BrandPanel />
        <div style={{ position: 'relative', padding: '44px 40px 36px', display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 520 }}>
          <button onClick={p.close} aria-label="Close" style={{ position: 'absolute', top: 18, right: 18, width: 36, height: 36, borderRadius: 9999, background: 'var(--raise2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon d={CLOSE_ICON} size={15} />
          </button>
          <StepBody {...p} variant="desktop" />
        </div>
      </div>
    </>
  );
}

function MobileSheet(p: FlowProps) {
  return (
    <>
      <div onClick={p.close} className="mk-scrim" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.55)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sign in"
        className="mk-sheet"
        style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 61, maxHeight: '92dvh', overflowY: 'auto', borderRadius: '32px 32px 0 0', background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)', boxShadow: '0 -1px 0 var(--line), 0 -20px 50px rgba(0,0,0,0.4)', padding: '12px 20px calc(30px + env(safe-area-inset-bottom))' }}
      >
        <div aria-hidden="true" style={{ width: 40, height: 4, borderRadius: 9999, background: 'var(--m3-outline)', margin: '0 auto 18px' }} />
        <StepBody {...p} variant="mobile" />
      </div>
    </>
  );
}

function BrandPanel() {
  const { markets } = useMarkets();
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const open = openPools(markets, now).length;
  const perk = (d: string, title: string, sub: string) => (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <span aria-hidden="true" style={{ flex: 'none', width: 40, height: 40, borderRadius: 9999, background: '#000', color: 'var(--mako-signal)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon d={d} size={18} stroke={1.9} />
      </span>
      <div>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
        <div style={{ fontSize: 14, lineHeight: 1.4, opacity: 0.72, marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
  return (
    <div style={{ position: 'relative', overflow: 'hidden', background: 'var(--mako-signal)', color: '#000', padding: '36px 34px', display: 'flex', flexDirection: 'column', borderRadius: '20px 0 0 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Logo size={40} />
        <span style={{ ...display, fontSize: 20, letterSpacing: '-0.02em' }}>Mako Market</span>
      </div>
      <div style={{ ...display, fontSize: 48, lineHeight: 0.98, letterSpacing: '-0.035em', marginTop: 40 }}>
        Bet in
        <br />
        seconds.
      </div>
      <div style={{ fontSize: 16, lineHeight: 1.5, marginTop: 12, opacity: 0.78, maxWidth: 300 }}>
        {ROUNDS_ADDRESS ? '15-minute BTC rounds and YES/NO pools, settled on-chain.' : 'YES/NO pools, settled on-chain. 15-minute BTC rounds are coming.'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 32 }}>
        {perk('M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z', 'No seed phrase', 'Your email is your account.')}
        {perk('M13 3L5 14h6l-1 7 8-11h-6z', 'Gas is paid for you', 'A bet costs only what you stake.')}
        {perk('M12 5v14M5 12h14', 'Free test USDC', 'From Circle’s faucet, to try it on Monad testnet.')}
      </div>
      {open > 0 && (
        <div style={{ marginTop: 'auto', paddingTop: 34, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 700 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#000' }} />
          {open} {open === 1 ? 'pool' : 'pools'} open now
        </div>
      )}
      <span aria-hidden="true" style={{ position: 'absolute', right: -70, bottom: 40, opacity: 0.07, pointerEvents: 'none', color: '#000' }}>
        <Logo size={260} />
      </span>
    </div>
  );
}

function Icon({ d, size, stroke = 1.75 }: { d: string; size: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

function StepBody(p: FlowProps & { variant: 'desktop' | 'mobile' }) {
  switch (p.step.kind) {
    case 'email':
      return <EmailStep {...p} />;
    case 'code':
      return <CodeStep {...p} />;
    case 'totp':
      return <TotpStepView {...p} />;
    case 'enroll':
      return <EnrollStep {...p} />;
    case 'wallet_setup':
      return <WalletSetupStep {...p} />;
    case 'wallet':
      return <WalletStep {...p} />;
    case 'done':
      return <DoneStep {...p} />;
  }
}

function title(variant: 'desktop' | 'mobile', text: string) {
  return <h2 style={{ margin: 0, ...display, fontSize: variant === 'desktop' ? 34 : 26, lineHeight: variant === 'desktop' ? 1.05 : 1.08, letterSpacing: variant === 'desktop' ? '-0.03em' : '-0.02em' }}>{text}</h2>;
}
const lead: React.CSSProperties = { fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', marginTop: 8 };

function bigButton(enabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    height: 56,
    marginTop: 14,
    borderRadius: 9999,
    background: enabled ? 'var(--mako-signal)' : 'var(--raise2)',
    color: enabled ? '#000' : 'var(--dim)',
    boxShadow: enabled ? 'var(--edge)' : 'none',
    ...display,
    fontSize: 17,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

function EmailStep({ step, email, setEmail, sendCode, setStep, variant }: FlowProps & { variant: 'desktop' | 'mobile' }) {
  if (step.kind !== 'email') return null;
  const ok = EMAIL.test(email.trim());
  const hint = step.error ?? (!email ? 'You get a one-time code. No password.' : ok ? 'Looks good.' : 'That doesn’t look like an email address yet.');
  const hintBad = !!step.error || (!!email && !ok);
  const input: React.CSSProperties = {
    height: variant === 'desktop' ? 60 : 56,
    width: '100%',
    boxSizing: 'border-box',
    padding: variant === 'desktop' ? '0 18px 0 50px' : '0 18px',
    border: 0,
    outline: 0,
    borderRadius: variant === 'desktop' ? 14 : 20,
    background: 'var(--raise)',
    boxShadow: `inset 0 0 0 1.5px ${hintBad ? 'var(--mako-red)' : ok ? 'var(--mako-canvas-fg)' : 'var(--line)'}`,
    color: 'var(--mako-canvas-fg)',
    fontFamily: 'var(--mako-font-sans)',
    fontSize: 17,
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        sendCode();
      }}
    >
      {title(variant, variant === 'desktop' ? 'Sign in or create an account' : 'Sign in to Mako Market')}
      <div style={lead}>{variant === 'desktop' ? 'Enter your email to get a 6-digit code. No password needed.' : 'Use your email. No wallet app, no seed phrase, and gas is paid for you.'}</div>
      <div style={{ position: 'relative', marginTop: variant === 'desktop' ? 26 : 18 }}>
        {variant === 'desktop' && (
          <span style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: 'var(--dim)', display: 'flex' }}>
            <Icon d="M4 6h16v12H4zM4 7l8 6 8-6" size={18} stroke={1.9} />
          </span>
        )}
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoComplete="email"
          autoFocus
          placeholder="you@email.com"
          aria-label="Email"
          style={input}
        />
      </div>
      <div role={step.error ? 'alert' : undefined} style={{ fontSize: 13, marginTop: 8, color: hintBad ? 'var(--mako-red)' : 'var(--dim)' }}>
        {hint}
      </div>
      <button type="submit" disabled={!ok || step.sending} className="m3-press m3-scale96" style={bigButton(ok && !step.sending)}>
        {step.sending ? 'Sending…' : 'Email me a code'}
      </button>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--dim)', marginTop: 14, textAlign: 'center' }}>
        By signing in you agree to the{' '}
        <Link href="/legal?tab=terms" onClick={() => closeSignIn()} style={{ color: 'inherit', textDecoration: 'underline' }}>
          terms
        </Link>
        . Mako Market runs on Monad testnet: balances are test USDC.
      </div>
      <button type="button" onClick={() => setStep({ kind: 'wallet', error: null, busy: false })} style={{ display: 'block', margin: '14px auto 0', fontSize: 13, fontWeight: 700, color: 'var(--dim)', textDecoration: 'underline' }}>
        Use a wallet instead
      </button>
    </form>
  );
}

/// INBOX_GAP_PLAN r18: an authenticator app before the account exists. Privy's headless enrollment, on Mako Market's
/// own screen (Privy's offers "Remove"). Copy: no em dashes, no "we/our/us".
function EnrollStep({ step, setStep, finishEnroll, variant }: FlowProps & { variant: 'desktop' | 'mobile' }) {
  if (step.kind !== 'enroll') return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        finishEnroll();
      }}
    >
      {title(variant, 'Protect your account')}
      <div style={lead}>
        Anyone who can read your email could otherwise use your wallet. With an authenticator app, your email alone can&apos;t move your funds: it also takes the code from the app.
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--dim)', marginTop: 10 }}>
        Pick an app that backs up your codes to your account, such as Google Authenticator signed in to Google, Authy, or 1Password, so a new phone gets them back. Lose the app and its backup, and you could lose access.
      </div>
      {step.authUrl ? (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <div style={{ background: '#fff', padding: 10, borderRadius: 12, lineHeight: 0 }}>
            <QRCodeSVG value={step.authUrl} size={variant === 'desktop' ? 148 : 132} level="M" />
          </div>
          <div style={{ flex: 1, minWidth: 160, fontSize: 13, lineHeight: 1.5, color: 'var(--dim)' }}>
            Scan this with the app, or{' '}
            <a href={step.authUrl} style={{ color: 'inherit', textDecoration: 'underline' }}>
              open it on this phone
            </a>
            .
            {step.secret && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer' }}>Enter the key by hand</summary>
                <code style={{ display: 'block', marginTop: 6, wordBreak: 'break-all', fontSize: 13, color: 'var(--mako-canvas-fg)' }}>{step.secret}</code>
              </details>
            )}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 16, fontSize: 14, color: 'var(--dim)' }}>{step.error ? '' : 'Preparing your authenticator…'}</div>
      )}
      <CodeBoxes
        value={step.code}
        onChange={(v) => setStep({ ...step, code: v, error: null })}
        bad={!!step.error}
        variant={variant}
        label="Code from your authenticator app"
        onEnter={finishEnroll}
      />
      <div role={step.error ? 'alert' : undefined} style={{ fontSize: 13, marginTop: 8, color: step.error ? 'var(--mako-red)' : 'var(--dim)' }}>
        {step.error ?? 'Enter the 6-digit code the app shows.'}
      </div>
      <button type="submit" disabled={step.submitting || step.code.length !== 6 || !step.authUrl} className="m3-press m3-scale96" style={bigButton(!step.submitting && step.code.length === 6 && !!step.authUrl)}>
        {step.submitting ? 'Setting up…' : 'Turn on and continue'}
      </button>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--dim)', marginTop: 12 }}>
        Changing phones or apps later? Move your codes with your authenticator&apos;s own transfer option. Don&apos;t turn two-factor off.
      </div>
    </form>
  );
}

/// INBOX_GAP_PLAN r18 [H2]: enrolled but no wallet yet (an interrupted setup). A fresh authenticator code first.
function WalletSetupStep({ step, setupWallet, variant }: FlowProps & { variant: 'desktop' | 'mobile' }) {
  if (step.kind !== 'wallet_setup') return null;
  return (
    <div>
      {title(variant, 'Finish setting up')}
      <div style={lead}>Your authenticator is on. Enter a code from it to create your wallet and finish signing in.</div>
      {step.error && (
        <div role="alert" style={{ fontSize: 13, marginTop: 12, color: 'var(--mako-red)' }}>
          {step.error}
        </div>
      )}
      <button type="button" onClick={setupWallet} disabled={step.busy} className="m3-press m3-scale96" style={bigButton(!step.busy)}>
        {step.busy ? 'Creating your wallet…' : 'Continue'}
      </button>
    </div>
  );
}

/// Six boxes over one real input, so paste, autofill of a one-time code and the keyboard all work.
function CodeBoxes({ value, onChange, bad, variant, label, onEnter }: { value: string; onChange: (v: string) => void; bad: boolean; variant: 'desktop' | 'mobile'; label: string; onEnter: () => void }) {
  return (
    <label style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8, marginTop: 18, cursor: 'text' }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          style={{ height: variant === 'desktop' ? 60 : 54, borderRadius: variant === 'desktop' ? 12 : 16, background: 'var(--raise)', boxShadow: `inset 0 0 0 1.5px ${bad ? 'var(--mako-red)' : i === value.length ? 'var(--mako-canvas-fg)' : 'var(--line)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 26, fontVariantNumeric: 'tabular-nums' }}
        >
          {value[i] ?? ''}
        </div>
      ))}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        aria-label={label}
        style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', border: 0, fontSize: 16 }}
      />
    </label>
  );
}

function CodeStep({ step, email, code, setCode, verify, setStep, sendCode, variant }: FlowProps & { variant: 'desktop' | 'mobile' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (step.kind !== 'code') return null;
  const left = Math.max(0, RESEND_AFTER_SEC - Math.floor((now - step.sentAt) / 1000));
  const ready = step.retryToken !== null || /^\d{6}$/.test(code);
  return (
    <div>
      {title(variant, 'Check your email')}
      <div style={lead}>
        A 6-digit code is on its way to <span style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>{email.trim()}</span>.
      </div>
      <CodeBoxes value={code} onChange={setCode} bad={!!step.error && !step.retryToken} variant={variant} label="6-digit code" onEnter={verify} />
      {step.error && (
        <div role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--mako-red)' }}>
          {step.error}
        </div>
      )}
      <button onClick={verify} disabled={!ready || step.verifying} className="m3-press m3-scale96" style={bigButton(ready && !step.verifying)}>
        {step.verifying ? 'Signing in…' : step.retryToken ? 'Try again' : 'Sign in'}
      </button>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 13, color: 'var(--dim)' }}>
        <button onClick={() => setStep({ kind: 'email', error: null, sending: false })} disabled={step.verifying} style={{ color: 'var(--dim)', fontWeight: 600 }}>
          Use a different email
        </button>
        {left > 0 ? (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>Resend in 0:{String(left).padStart(2, '0')}</span>
        ) : (
          <button onClick={sendCode} disabled={step.verifying} style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>
            Resend code
          </button>
        )}
      </div>
    </div>
  );
}

function TotpStepView({ step, submit2fa, setStep, variant }: FlowProps & { variant: 'desktop' | 'mobile' }) {
  const [value, setValue] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (step.kind !== 'totp') return null;
  const s = step.state;
  const locked = s.lockedUntil !== null && s.lockedUntil > now;
  const terminal =
    s.terminal === 'challenge_invalid'
      ? 'This sign-in expired. Start again with your email.'
      : s.terminal === 'eoa_drift'
        ? 'Your account changed while signing in. Start again with your email.'
        : null;
  return (
    <div>
      {title(variant, 'Two-step sign-in')}
      <div style={lead}>{s.mode === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes. Each works once.'}</div>
      {terminal ? (
        <>
          <div role="alert" style={{ fontSize: 14, marginTop: 18, color: 'var(--mako-red)' }}>
            {terminal}
          </div>
          <button onClick={() => setStep({ kind: 'email', error: null, sending: false })} className="m3-press m3-scale96" style={bigButton(true)}>
            Start again
          </button>
        </>
      ) : (
        <>
          {s.mode === 'totp' ? (
            <CodeBoxes value={value} onChange={setValue} bad={!!s.error} variant={variant} label="Authenticator code" onEnter={() => submit2fa(value)} />
          ) : (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit2fa(value)}
              autoFocus
              autoCapitalize="none"
              aria-label="Recovery code"
              style={{ marginTop: 18, height: 56, width: '100%', boxSizing: 'border-box', padding: '0 18px', border: 0, outline: 0, borderRadius: 14, background: 'var(--raise)', boxShadow: `inset 0 0 0 1.5px ${s.error ? 'var(--mako-red)' : 'var(--line)'}`, color: 'var(--mako-canvas-fg)', fontFamily: 'var(--mako-font-mono)', fontSize: 17 }}
            />
          )}
          {(s.error || locked) && (
            <div role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--mako-red)' }}>
              {locked ? `Too many wrong codes. Try again in ${formatLockoutRemaining(s.lockedUntil!, now)}.` : s.error}
            </div>
          )}
          <button onClick={() => submit2fa(value)} disabled={s.submitting || locked || !value.trim()} className="m3-press m3-scale96" style={bigButton(!s.submitting && !locked && !!value.trim())}>
            {s.submitting ? 'Checking…' : 'Sign in'}
          </button>
          <button
            onClick={() => {
              setValue('');
              setStep({ kind: 'totp', state: { ...s, mode: s.mode === 'totp' ? 'recovery' : 'totp', error: null } });
            }}
            disabled={s.submitting || locked}
            style={{ display: 'block', margin: '14px auto 0', fontSize: 13, fontWeight: 700, color: 'var(--dim)', textDecoration: 'underline' }}
          >
            {s.mode === 'totp' ? 'Use a recovery code instead' : 'Use your authenticator instead'}
          </button>
        </>
      )}
    </div>
  );
}

function WalletStep({ step, setStep, signedIn, variant }: FlowProps & { variant: 'desktop' | 'mobile' }) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  if (step.kind !== 'wallet') return null;
  const signIn = async () => {
    if (!address) return;
    setStep({ kind: 'wallet', error: null, busy: true });
    const r = await signInWithWallet({ address, signMessageAsync });
    if (r.ok) signedIn(r.user, r.user.lastSignInAt === null);
    else setStep({ kind: 'wallet', error: r.error === 'nonce_failed' ? "Couldn't start the sign-in. Try again." : 'The wallet did not sign, or the signature was refused. Try again.', busy: false });
  };
  return (
    <div>
      {title(variant, 'Sign in with a wallet')}
      <div style={lead}>Connect your wallet and sign one message to prove it is yours. Wallet accounts pay their own gas in MON.</div>
      {isConnected && address ? (
        <button onClick={signIn} disabled={step.busy} className="m3-press m3-scale96" style={{ ...bigButton(!step.busy), marginTop: 22 }}>
          {step.busy ? 'Waiting for your wallet…' : `Sign in as ${formatAddress(address)}`}
        </button>
      ) : (
        <button onClick={() => openConnectModal?.()} disabled={!openConnectModal} className="m3-press m3-scale96" style={{ ...bigButton(!!openConnectModal), marginTop: 22 }}>
          Connect a wallet
        </button>
      )}
      {step.error && (
        <div role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--mako-red)' }}>
          {step.error}
        </div>
      )}
      <button onClick={() => setStep({ kind: 'email', error: null, sending: false })} disabled={step.busy} style={{ display: 'block', margin: '14px auto 0', fontSize: 13, fontWeight: 700, color: 'var(--dim)', textDecoration: 'underline' }}>
        Use your email instead
      </button>
    </div>
  );
}

/// The first sign-in of an account: "You're in", with the beta notice (Joshua, 2026-09-30: shown once, after the
/// first sign-in).
function DoneStep({ step, close, variant }: FlowProps & { variant: 'desktop' | 'mobile' }) {
  const [copied, setCopied] = useState(false);
  if (step.kind !== 'done') return null;
  const user = step.user;
  const address = accountAddress(user);
  const email = user.authType === 'magic';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div>
      <Mascot pose="mako-wave" motion="sway" alt="" style={{ height: 150, width: 'auto', display: 'block', margin: '-10px 0 -6px' }} />
      <h2 style={{ margin: '14px 0 0', ...display, fontSize: variant === 'desktop' ? 30 : 26, lineHeight: 1.08, letterSpacing: '-0.02em' }}>You’re in</h2>
      <div style={lead}>
        {email
          ? `Your account is ready: ${formatAddress(address)}. There’s nothing to back up. Gas is sponsored, so every bet costs only what you stake.`
          : `Your wallet ${formatAddress(address)} is signed in. You pay gas in MON from it.`}
      </div>
      <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: variant === 'desktop' ? 14 : 22, background: 'var(--mako-violet)', color: '#000', boxShadow: 'var(--edge)' }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>Mako Market is in beta</div>
        <div style={{ fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>
          It runs on Monad testnet, so USDC here is test money with no real value. By continuing, you agree to the{' '}
          <Link href="/legal?tab=terms" onClick={() => closeSignIn()} style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 700 }}>
            beta terms
          </Link>
          .
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, padding: '12px 16px', borderRadius: variant === 'desktop' ? 14 : 22, background: 'var(--raise)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Get free test USDC</div>
          <div style={{ fontSize: 12, color: 'var(--dim)' }}>Circle’s faucet asks for your address.</div>
        </div>
        <button onClick={copy} className="m3-press" style={{ flex: 'none', height: 36, padding: '0 12px', borderRadius: 9999, background: 'var(--raise2)', fontSize: 13, fontWeight: 700 }}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="m3-press" style={{ flex: 'none', height: 36, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 9999, background: '#000', color: '#fff', fontSize: 13, fontWeight: 800, textDecoration: 'none' }}>
          Faucet ↗
        </a>
      </div>
      <button onClick={close} className="m3-press m3-scale96" style={bigButton(true)}>
        Start betting
      </button>
    </div>
  );
}
