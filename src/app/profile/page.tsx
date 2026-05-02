'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, useBalance, useDisconnect } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { isAddress, parseUnits, type Address } from 'viem';

import { useUser, USER_QUERY_KEY } from '@/lib/use-user';
import { WarningModal } from '@/components/WarningModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { runSendUsdc } from '@/lib/aa-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS } from '@/lib/contract';
import { SEND_USDC_MAX_PER_OP_BASE_UNITS } from '@/lib/aa-constants';
import {
  EmailUpdateNotSupported,
  getMagic,
  updateEmailWithMagic,
} from '@/lib/magic-browser';

function formatAddress(address: string | undefined): string {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const SEND_USDC_MAX_PER_OP_USDC = Number(
  SEND_USDC_MAX_PER_OP_BASE_UNITS / 1_000_000n,
);

/// Send-flow phase. Three on-chain stages plus terminal outcomes.
///
/// idle       — form is editable
/// sending    — userOp posted to bundler, awaiting acceptance
/// confirming — bundler accepted, awaiting on-chain receipt (~5-15s on
///              Monad testnet given current Pimlico polling cadence)
/// sent       — receipt landed, success
/// reverted   — receipt landed but execution reverted on chain
/// error      — pre-submit failure (sponsorship rejected, expired, etc)
type SendPhase =
  | 'idle'
  | 'sending'
  | 'confirming'
  | 'sent'
  | 'reverted'
  | 'error';

/// Email-edit phase. The Magic flow opens an OTP modal on Magic's side;
/// our state machine just tracks which step Mako is in.
type EmailEditPhase = 'closed' | 'open' | 'updating' | 'unsupported';

export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: isUserLoading } = useUser();
  const { address: connectedWallet } = useAccount();
  const { disconnect } = useDisconnect();

  // Component States. Two transition flags rather than one shared
  // `signingOut`: clicking SWITCH ACCOUNT shouldn't make SIGN OUT also
  // render its pending state, and vice versa. Both buttons stay
  // disabled while either flow is in flight (a sign-out mid-switch is
  // a bug we don't try to handle gracefully).
  const [signingOut, setSigningOut] = useState(false);
  const [switching, setSwitching] = useState(false);
  const transitionInFlight = signingOut || switching;
  const [copied, setCopied] = useState(false);
  const [eoaCopied, setEoaCopied] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  // Modal State
  const [activeModal, setActiveModal] = useState<
    'none' | 'export' | 'send' | 'switch'
  >('none');

  // Send Form State
  const [sendDestination, setSendDestination] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendPhase, setSendPhase] = useState<SendPhase>('idle');
  const [sendError, setSendError] = useState('');
  const [sendTxHash, setSendTxHash] = useState<`0x${string}` | null>(null);

  // Email Edit State
  const [emailEdit, setEmailEdit] = useState<EmailEditPhase>('closed');
  const [newEmailInput, setNewEmailInput] = useState('');
  const [emailEditError, setEmailEditError] = useState('');

  // Address resolution: Magic Safe takes precedence if logged in,
  // otherwise connected wallet.
  const isMagicUser = !!user;
  const canonicalAddress = user
    ? (user.safeAddress as `0x${string}`)
    : connectedWallet;

  // Fetch USDC Balance
  const usdcAddress =
    process.env.NEXT_PUBLIC_USDC_ADDRESS_MONAD_TESTNET ||
    '0x534b2f3A21130d7a60830c2Df862319e593943A3';

  const {
    data: balanceData,
    isLoading: isBalanceLoading,
    isError: isBalanceError,
    refetch: refetchBalance,
  } = useBalance({
    address: canonicalAddress,
    token: usdcAddress as `0x${string}`,
    query: {
      enabled: !!canonicalAddress,
    },
  });

  const availableBalance = balanceData ? parseFloat(balanceData.formatted) : 0;
  const availableBalanceBaseUnits =
    balanceData?.value !== undefined ? balanceData.value : 0n;

  // Inline contract-address warning (NOT a hard error — server allowlist
  // catches these too with bad_send_recipient, but a friendly heads-up
  // before the user clicks REVIEW is better UX).
  const recipientLooksLikeContract =
    sendDestination &&
    isAddress(sendDestination) &&
    (sendDestination.toLowerCase() === usdcAddress.toLowerCase() ||
      sendDestination.toLowerCase() === MAKO_ADDRESS.toLowerCase());

  // Handlers
  const handleCopy = (text: string, setter: (val: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  const handleSignOut = async () => {
    if (transitionInFlight) return;
    setSigningOut(true);
    try {
      const res = await fetch('/api/user/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) {
        queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
        router.push('/');
      }
    } finally {
      setSigningOut(false);
    }
  };

  // Switch account for a wallet user. RainbowKit doesn't expose a
  // first-class "switch wallet" primitive, so we disconnect the current
  // wallet and bounce them to /signup — there they can reconnect a
  // different wallet via the existing entry path or fall through to
  // email sign-in. Symmetric with the Magic-user version below: both
  // paths arrive at /signup, both require the user to deliberately
  // re-authenticate.
  const handleSwitchWallet = () => {
    if (transitionInFlight) return;
    setSwitching(true);
    try {
      disconnect();
    } catch (e) {
      console.warn('Wallet disconnect during switch failed', e);
    }
    queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
    router.push('/signup');
    // Don't clear `switching` — let the unmount handle it.
  };

  // Switch account = sign out current Magic session AND log out of Magic
  // browser-side, then redirect to /signup. Magic's `user.logout()` has
  // been observed to hang for tens of seconds when the user's network
  // is degraded — which would leave the button stuck in "SWITCHING…".
  // Fire it in parallel with our own /api/user/logout and bound the
  // total wait via Promise.race against a 4s timeout. Magic-side state
  // expires on its own anyway (~10 min default TTL), so a missed call
  // here is at worst inconvenient; what we MUST avoid is blocking the
  // redirect to /signup.
  const handleSwitchAccount = async () => {
    if (transitionInFlight) return;
    setSwitching(true);

    const magicLogout = (async () => {
      try {
        const magic = await getMagic();
        await magic.user.logout();
      } catch (e) {
        console.warn('Magic logout failed during switch-account', e);
      }
    })();

    const localLogout = fetch('/api/user/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });

    // Wait for our own logout (authoritative) but don't block on Magic.
    // 4s is enough headroom for a healthy Magic call without being
    // perceptibly slow if Magic is degraded.
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, 4000),
    );
    await Promise.race([magicLogout, timeout]);

    let localRes: Response | null = null;
    try {
      localRes = await localLogout;
    } catch {
      // Network blip on /api/user/logout is bad but not fatal — the
      // session will expire on its own. Surface to the user by NOT
      // redirecting, leaving the button enabled for retry.
    }

    if (localRes && localRes.ok) {
      queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      router.push('/signup');
      // Intentionally do NOT clear `switching` here — we want the
      // button to stay in its pending state until the navigation
      // commits. The unmount cleans state.
      return;
    }
    setSwitching(false);
  };

  const handleExportKey = async () => {
    try {
      const magic = await getMagic();
      await magic.user.showSettings();
    } catch (e) {
      console.error('Failed to open magic settings', e);
    }
  };

  // ── Email change flow ────────────────────────────────────────────────────
  const handleStartEditEmail = () => {
    setEmailEditError('');
    setNewEmailInput('');
    setEmailEdit('open');
  };

  const handleCancelEditEmail = () => {
    setEmailEdit('closed');
    setNewEmailInput('');
    setEmailEditError('');
  };

  const handleSubmitEditEmail = async () => {
    setEmailEditError('');
    const trimmed = newEmailInput.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setEmailEditError('Enter a valid email address.');
      return;
    }
    if (user && trimmed.toLowerCase() === user.email.toLowerCase()) {
      setEmailEditError('That is already your email.');
      return;
    }

    setEmailEdit('updating');
    try {
      const { didToken } = await updateEmailWithMagic({ newEmail: trimmed });

      const res = await fetch('/api/user/email/update', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ didToken }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (body.error === 'email_taken') {
          setEmailEditError('That email is already in use by another account.');
        } else if (body.error === 'not_allowlisted') {
          setEmailEditError(
            'That email is not on the beta allowlist. Pick a different address or contact support.',
          );
        } else if (body.error === 'eoa_mismatch') {
          setEmailEditError(
            "Magic returned a different wallet than expected. We didn't update anything. Please refresh and try again.",
          );
        } else {
          setEmailEditError(
            'Email update failed. Please refresh and try again.',
          );
        }
        setEmailEdit('open');
        return;
      }

      await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      handleCancelEditEmail();
    } catch (e) {
      if (e instanceof EmailUpdateNotSupported) {
        setEmailEdit('unsupported');
        return;
      }
      console.error('Email change failed', e);
      setEmailEditError(
        'Magic could not complete the change. If you closed the modal, try again.',
      );
      setEmailEdit('open');
    }
  };

  // ── Send flow ─────────────────────────────────────────────────────────────
  const handleReviewSend = () => {
    setSendError('');
    if (!isAddress(sendDestination)) {
      setSendError('Invalid destination address.');
      return;
    }
    if (sendDestination.toLowerCase() === canonicalAddress?.toLowerCase()) {
      setSendError('You cannot send to your own address.');
      return;
    }

    let amountBaseUnits: bigint;
    try {
      amountBaseUnits = parseUnits(sendAmount || '0', 6);
    } catch {
      setSendError('Invalid amount.');
      return;
    }
    if (amountBaseUnits <= 0n) {
      setSendError('Enter an amount greater than zero.');
      return;
    }
    if (amountBaseUnits > availableBalanceBaseUnits) {
      setSendError('Not enough USDC to cover this send.');
      return;
    }
    if (amountBaseUnits > SEND_USDC_MAX_PER_OP_BASE_UNITS) {
      setSendError(
        `Per-transaction cap is ${SEND_USDC_MAX_PER_OP_USDC} USDC.`,
      );
      return;
    }
    setActiveModal('send');
  };

  const executeSend = async () => {
    setActiveModal('none');
    if (!user || !canonicalAddress) {
      setSendPhase('error');
      setSendError('You must be signed in via email to send from this Safe.');
      return;
    }

    let amountBaseUnits: bigint;
    try {
      amountBaseUnits = parseUnits(sendAmount, 6);
    } catch {
      setSendPhase('error');
      setSendError('Invalid amount.');
      return;
    }

    setSendPhase('sending');
    setSendTxHash(null);

    let outcome;
    try {
      outcome = await runSendUsdc({
        chainId: MONAD_TESTNET_ID,
        recipient: sendDestination as Address,
        amountUsdc: amountBaseUnits,
        usdcAddress: usdcAddress as Address,
        magicEoa: user.magicEoa as Address,
      });
    } catch (e) {
      console.error('Send failed', e);
      setSendPhase('error');
      setSendError(
        'Send failed before reaching the network. Try again in a moment.',
      );
      return;
    }

    switch (outcome.kind) {
      case 'submitted':
        setSendPhase('confirming');
        break;
      case 'in_progress':
        setSendPhase('confirming');
        break;
      case 'sent':
        setSendTxHash(outcome.txHash);
        setSendPhase('sent');
        break;
      case 'reverted':
        setSendTxHash(outcome.txHash);
        setSendPhase('reverted');
        setSendError('The send reverted on chain. No funds were moved.');
        break;
      case 'sponsor_failed':
        setSendPhase('error');
        if (outcome.reason === 'CAP_EXCEEDED') {
          setSendError('Daily send limit reached. Try again tomorrow.');
        } else if (outcome.reason === 'bad_send_recipient') {
          setSendError(
            'That recipient is not allowed (self-send or protocol contract).',
          );
        } else if (outcome.reason === 'bad_send_amount') {
          setSendError(
            `Amount is outside the allowed range. Per-transaction cap is ${SEND_USDC_MAX_PER_OP_USDC} USDC.`,
          );
        } else {
          setSendError(
            'Could not sponsor this send right now. If this persists, contact support.',
          );
        }
        break;
      case 'send_failed':
        setSendPhase('error');
        setSendError(
          'Send failed after sponsorship. Please refresh and try again.',
        );
        break;
      case 'expired':
        setSendPhase('error');
        setSendError('Send expired before completing. Please try again.');
        break;
      case 'manual_review':
        setSendPhase('error');
        setSendError(
          'This send needs operator review. Contact support with your wallet address.',
        );
        break;
      case 'failed_pre_submit':
        setSendPhase('error');
        setSendError(
          outcome.failureReason ||
            'The bundler rejected this send before broadcast.',
        );
        break;
    }
  };

  const handleDismissSendOutcome = () => {
    setSendPhase('idle');
    setSendError('');
    setSendTxHash(null);
    setSendAmount('');
    setSendDestination('');
    refetchBalance();
  };

  if (isUserLoading) {
    return (
      <main className="flex-1 flex flex-col pb-20 md:pb-10 w-full">
        <header className="hidden md:flex items-center justify-between px-6 lg:px-8 h-12 border-b-2 border-chrome-divider bg-chrome text-chrome-fg sticky top-0 z-30">
          <h1 className="mako-display text-sm lg:text-base">ACCOUNT</h1>
          <ThemeToggle />
        </header>
        <div className="w-full max-w-6xl mx-auto px-4 py-6 md:py-10 grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-6 mako-skeleton h-[300px]" />
          <div className="lg:col-span-6 mako-skeleton h-[400px]" />
        </div>
      </main>
    );
  }

  const identityLabel = user ? user.email : formatAddress(connectedWallet);

  return (
    <main className="flex-1 flex flex-col w-full pb-20 md:pb-10">
      <header className="hidden md:flex items-center justify-between px-6 lg:px-8 h-12 border-b-2 border-chrome-divider bg-chrome text-chrome-fg sticky top-0 z-30">
        <h1 className="mako-display text-sm lg:text-base">ACCOUNT</h1>
        <ThemeToggle />
      </header>

      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-10 flex flex-col gap-8">

        {/* Mobile Header */}
        <div className="md:hidden flex items-center justify-between mb-2">
          <h1 className="mako-display text-3xl text-chrome-fg">ACCOUNT</h1>
          <ThemeToggle />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

          {/* LEFT COLUMN: Identity, Balance & Security */}
          <div className="lg:col-span-6 flex flex-col gap-8">

            {/* 1. Identity & Balance */}
            <section className="mako-card text-ink flex flex-col">
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-6">
                <div className="w-full">
                  <div className="flex justify-between items-center mb-1">
                    <h2 className="mako-label text-muted">SIGNED IN AS</h2>
                    {isMagicUser && emailEdit === 'closed' && (
                      <button
                        onClick={handleStartEditEmail}
                        className="mako-label text-[10px] text-ink opacity-60 hover:opacity-100 hover:underline transition-opacity"
                      >
                        EDIT
                      </button>
                    )}
                  </div>
                  <p className="mako-title text-xl break-all leading-tight mb-2">{identityLabel}</p>

                  {isMagicUser && emailEdit === 'open' && (
                    <div className="mt-3 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-ink">
                      <label className="mako-label text-[10px] text-ink">NEW EMAIL</label>
                      <input
                        type="email"
                        value={newEmailInput}
                        onChange={(e) => setNewEmailInput(e.target.value)}
                        placeholder="you@example.com"
                        className="mako-input mako-mono text-sm bg-white"
                        autoFocus
                      />
                      {emailEditError && (
                        <p className="mako-body text-xs font-medium text-mako-red">
                          {emailEditError}
                        </p>
                      )}
                      <div className="flex gap-2 mt-1">
                        <button
                          onClick={handleSubmitEditEmail}
                          className="mako-button mako-label text-[10px] flex-1 sm:flex-initial"
                        >
                          UPDATE EMAIL
                        </button>
                        <button
                          onClick={handleCancelEditEmail}
                          className="mako-button mako-button--ghost mako-label text-[10px] flex-1 sm:flex-initial"
                        >
                          CANCEL
                        </button>
                      </div>
                      <p className="mako-body text-[10px] text-muted leading-snug mt-1">
                        Magic will email a code to your new address to confirm. Your wallet address stays the same.
                      </p>
                    </div>
                  )}

                  {isMagicUser && emailEdit === 'updating' && (
                    <div className="mt-3 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-ink">
                      <p className="mako-body text-sm text-ink">
                        Updating email through Magic. Check the new address for an OTP.
                      </p>
                    </div>
                  )}

                  {isMagicUser && emailEdit === 'unsupported' && (
                    <div className="mt-3 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-mako-red">
                      <p className="mako-body text-sm text-ink">
                        Email change is not available in this app. To use a different address, contact support and we will help you migrate your funds.
                      </p>
                      <button
                        onClick={() => setEmailEdit('closed')}
                        className="mako-button mako-button--ghost mako-label text-[10px] self-start"
                      >
                        DISMISS
                      </button>
                    </div>
                  )}

                  {isMagicUser && emailEdit === 'closed' && (
                    <div className="flex flex-col gap-1">
                      <p className="mako-label text-[9px] text-muted">
                        LAST SIGN-IN: {user?.lastSignInAt ? new Date(user.lastSignInAt).toLocaleString() : 'First sign-in'}
                      </p>
                      <p className="mako-body text-[11px] text-muted leading-snug mt-1 max-w-md">
                        If you lose access to this email, account recovery is managed through <a href="https://magic.link" target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">Magic</a>. Mako Markets cannot recover your funds.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t-2 border-ink pt-6 mt-auto">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="mako-label text-muted">AVAILABLE BALANCE</h3>
                  <div className="mako-sticker mako-sticker--ink whitespace-nowrap scale-75 origin-right">
                    MONAD TESTNET
                  </div>
                </div>

                <div className="flex items-end gap-3">
                  {isBalanceLoading ? (
                    <div className="mako-skeleton h-12 w-48" />
                  ) : isBalanceError ? (
                    <div className="flex items-center gap-3">
                      <span className="font-display font-black text-4xl md:text-5xl tracking-tighter text-ink leading-none">--- USDC</span>
                      <button onClick={() => refetchBalance()} className="w-10 h-10 flex items-center justify-center border-2 border-ink rounded-full hover:bg-ink hover:text-white transition-colors" aria-label="Retry">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <span className="font-display font-black text-5xl md:text-6xl tracking-tighter text-ink leading-none">
                      {balanceData ? parseFloat(balanceData.formatted).toFixed(2) : '0.00'} <span className="text-3xl text-muted ml-1">USDC</span>
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* 4. Security & Recovery */}
            <section className={`mako-card text-ink relative overflow-hidden flex flex-col gap-5 ${isMagicUser ? 'border-mako-red shadow-[4px_4px_0_0_#D94A3D]' : ''}`}>
              {isMagicUser && <div className="absolute inset-0 bg-mako-red/5 pointer-events-none" />}

              <div className="relative z-10 flex flex-col gap-5">
                <h2 className={`mako-display text-2xl ${isMagicUser ? 'text-mako-red' : 'text-ink'}`}>SECURITY</h2>

                {isMagicUser ? (
                  <>
                    <p className="mako-body text-ink text-lg leading-relaxed">
                      Your email is your wallet. Mako Markets does not hold your funds. Magic provides the authentication.
                      <strong className="block mt-2">If your email account is compromised, your funds are at risk.</strong>
                    </p>

                    <div className="bg-surface-elevated border-2 border-ink p-4 rounded-xl flex gap-3 items-start">
                      <svg className="w-6 h-6 text-mako-signal shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                      <p className="mako-label text-[10px] text-ink leading-relaxed">
                        TIP: WE STRONGLY RECOMMEND ENABLING 2FA ON YOUR EMAIL ACCOUNT. HARDWARE WALLET UPGRADES ARE COMING SOON.
                      </p>
                    </div>

                    <div className="mt-4 pt-6 border-t-2 border-ink/10">
                      <button
                        onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
                        className="mako-label text-xs text-ink hover:underline opacity-60 hover:opacity-100 transition-opacity flex items-center gap-2"
                      >
                        {showTechnicalDetails ? 'HIDE TECHNICAL DETAILS' : 'SHOW TECHNICAL DETAILS'}
                        <svg className={`w-4 h-4 transition-transform ${showTechnicalDetails ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
                      </button>

                      {showTechnicalDetails && user && (
                        <div className="mt-6 flex flex-col gap-6">
                          <div className="bg-paper p-4 rounded-xl border-2 border-ink flex flex-col gap-2">
                            <span className="mako-label text-ink">UNDERLYING SIGNER (EOA)</span>
                            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                              <code className="mako-mono text-sm bg-surface-elevated border-2 border-ink px-4 py-3 flex-1 flex items-center">
                                {formatAddress(user.magicEoa)}
                              </code>
                              <button
                                onClick={() => handleCopy(user.magicEoa, setEoaCopied)}
                                className="mako-button mako-label w-full sm:w-auto px-4!"
                              >
                                {eoaCopied ? 'COPIED!' : 'COPY EOA'}
                              </button>
                            </div>
                          </div>

                          <div className="flex flex-col gap-2">
                            <span className="mako-label text-ink">ADVANCED RECOVERY</span>
                            <button
                              onClick={() => setActiveModal('export')}
                              className="mako-button mako-button--action w-full sm:w-auto self-start"
                            >
                              EXPORT PRIVATE KEY
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mako-body text-ink text-lg">
                    You are using your own wallet. Key management is your responsibility.
                  </p>
                )}
              </div>
            </section>
          </div>

          {/* RIGHT COLUMN: Send & Receive */}
          <div className="lg:col-span-6 flex flex-col gap-8">

            {/* 3. Send USDC — Magic users only. Wallet users have their
                own wallet's send-token UI which we don't duplicate. */}
            {isMagicUser && canonicalAddress && (
               <section className="mako-card text-ink flex flex-col gap-5 border-4 border-ink relative overflow-hidden">
                <h2 className="mako-display text-2xl">SEND USDC</h2>

                {sendPhase === 'sending' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-4">
                    <div className="w-12 h-12 border-4 border-ink border-t-mako-red rounded-full animate-spin" />
                    <h3 className="mako-display text-xl animate-pulse text-ink mt-2">SENDING TO BUNDLER...</h3>
                    <p className="mako-body text-sm text-muted">Asking Pimlico to sponsor this send.</p>
                  </div>
                )}

                {sendPhase === 'confirming' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-4">
                    <div className="w-12 h-12 border-4 border-mako-red border-t-ink rounded-full animate-spin" />
                    <h3 className="mako-display text-xl animate-pulse text-ink mt-2">CONFIRMING ON CHAIN...</h3>
                    <p className="mako-body text-sm text-muted">Waiting for Monad to land your transaction.</p>
                  </div>
                )}

                {sendPhase === 'sent' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-4">
                    <div className="w-12 h-12 bg-mako-ink text-mako-paper rounded-full flex items-center justify-center shadow-[4px_4px_0_0_#D94A3D]">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                    <h3 className="mako-display text-xl text-ink mt-2">SENT ✓</h3>
                    {sendTxHash && (
                      <a
                        href={`https://testnet.monadexplorer.com/tx/${sendTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mako-label text-[10px] text-mako-red hover:underline"
                      >
                        VIEW ON EXPLORER
                      </a>
                    )}
                    <button
                      onClick={handleDismissSendOutcome}
                      className="mako-button mako-button--ghost mako-label text-[10px] mt-2"
                    >
                      SEND ANOTHER
                    </button>
                  </div>
                )}

                {sendPhase === 'reverted' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-4">
                    <h3 className="mako-display text-xl text-mako-red mt-2">REVERTED</h3>
                    <p className="mako-body text-sm text-muted text-center">{sendError}</p>
                    {sendTxHash && (
                      <a
                        href={`https://testnet.monadexplorer.com/tx/${sendTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mako-label text-[10px] text-mako-red hover:underline"
                      >
                        VIEW ON EXPLORER
                      </a>
                    )}
                    <button
                      onClick={handleDismissSendOutcome}
                      className="mako-button mako-button--ghost mako-label text-[10px] mt-2"
                    >
                      DISMISS
                    </button>
                  </div>
                )}

                {sendPhase === 'error' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-4">
                    <h3 className="mako-display text-xl text-mako-red mt-2">SEND FAILED</h3>
                    <p className="mako-body text-sm text-muted text-center">{sendError}</p>
                    <button
                      onClick={handleDismissSendOutcome}
                      className="mako-button mako-button--ghost mako-label text-[10px] mt-2"
                    >
                      DISMISS
                    </button>
                  </div>
                )}

                {sendPhase === 'idle' && (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="mako-label text-ink">DESTINATION ADDRESS</label>
                      <input
                        type="text"
                        value={sendDestination}
                        onChange={(e) => setSendDestination(e.target.value)}
                        placeholder="0x..."
                        className="mako-input mako-mono text-sm bg-white"
                      />
                      {recipientLooksLikeContract && (
                        <p className="mako-body text-[11px] text-mako-red mt-1">
                          That address looks like a Mako or USDC contract, not a wallet. Sends to contracts will be rejected.
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between items-end">
                        <label className="mako-label text-ink">AMOUNT (USDC)</label>
                        <span className="mako-label text-[10px] text-muted">Avail: {availableBalance.toFixed(2)}</span>
                      </div>
                      <div className="relative">
                        <input
                          type="number"
                          min="0"
                          step="0.000001"
                          value={sendAmount}
                          onChange={(e) => setSendAmount(e.target.value)}
                          placeholder="0.00"
                          className="mako-input mako-display text-xl bg-white pr-20"
                        />
                        <button
                          onClick={() => {
                            // Use the chain-read formatted balance verbatim
                            // (already 6-decimal precision) so MAX matches
                            // available exactly without float drift.
                            if (balanceData) setSendAmount(balanceData.formatted);
                          }}
                          className="absolute right-2 top-2 bottom-2 bg-surface-elevated border-2 border-ink px-3 rounded-lg mako-label text-[10px] hover:bg-ink hover:text-white transition-colors"
                        >
                          MAX
                        </button>
                      </div>
                      <p className="mako-label text-[9px] text-muted">
                        Per-transaction cap: {SEND_USDC_MAX_PER_OP_USDC} USDC.
                      </p>
                    </div>

                    {sendError && (
                      <p className="mako-body text-sm font-medium text-mako-red bg-mako-red/10 border-2 border-mako-red p-2 rounded-lg text-center">
                        {sendError}
                      </p>
                    )}

                    <button
                      onClick={handleReviewSend}
                      disabled={!sendAmount || !sendDestination}
                      className="mako-button mako-button--yes w-full mt-2"
                    >
                      REVIEW SEND
                    </button>
                  </div>
                )}
              </section>
            )}

            {/* 2. Receive USDC */}
            {canonicalAddress && (
              <section className="mako-card text-ink flex flex-col gap-6">
                <div className="flex justify-between items-center">
                  <h2 className="mako-display text-2xl">RECEIVE USDC</h2>
                  <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer" className="mako-label text-[10px] text-mako-red hover:underline flex items-center gap-1">
                    GET TESTNET FUNDS <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                  </a>
                </div>

                <div className="flex flex-col sm:flex-row gap-6 items-center min-w-0">
                  <div className="shrink-0 p-3 border-4 border-ink bg-white transform rotate-1 shadow-brutal-sm">
                    <QRCodeSVG
                      value={canonicalAddress}
                      size={140}
                      bgColor="#FFFFFF"
                      fgColor="#000000"
                      level="M"
                    />
                  </div>

                  <div className="flex flex-col gap-3 flex-1 w-full min-w-0">
                    <p className="mako-body text-sm">
                      Send USDC directly to this address on Monad. This is your personal smart wallet.
                      <strong className="block text-mako-red mt-1">Any other tokens or chains will be permanently lost.</strong>
                    </p>
                    <div className="mako-label text-[9px] text-muted break-all">
                      CANONICAL USDC: {usdcAddress}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 pt-4 border-t-2 border-ink">
                  <span className="mako-label text-ink">YOUR WALLET ADDRESS</span>
                  <div className="flex gap-2">
                    <code className="mako-mono text-sm bg-surface-elevated border-2 border-ink px-3 py-3 flex-1 flex items-center justify-center shadow-inner">
                      {formatAddress(canonicalAddress)}
                    </code>
                    <button
                      onClick={() => handleCopy(canonicalAddress, setCopied)}
                      className="mako-button mako-label px-4! shrink-0"
                    >
                      {copied ? 'COPIED!' : 'COPY'}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>

        {/* 5. Bottom Section: Advanced & Support & Sign Out */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-end gap-8 mt-4 pt-10 border-t-2 border-chrome-divider">
          <div className="flex flex-col md:flex-row gap-12 w-full lg:w-auto">
            {/* Advanced (external wallet) — hidden for Magic users.
                A Magic user already has an account via email. Surfacing
                "connect external wallet" here would let them attach a
                second auth method to the same browser, which makes the
                identity model ambiguous downstream (which key signs the
                next bet?). Account transfer between auth methods is a
                deliberate Phase 5+ feature, not a side-effect of
                connecting a wallet here. */}
            {!isMagicUser && (
            <section className="flex flex-col items-start gap-4">
              <h3 className="mako-display text-xl text-chrome-fg">ADVANCED</h3>
              <p className="mako-body text-muted text-sm max-w-[200px] mb-1">
                {connectedWallet ? 'Your connected external wallet.' : 'Prefer your own wallet? Connect it here.'}
              </p>

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
                    return <div className="mako-button opacity-0" aria-hidden="true">Loading</div>;
                  }

                  if (!connected) {
                    return (
                      <button onClick={openConnectModal} type="button" className="font-display font-black uppercase tracking-widest text-sm px-8 py-4 border-2 border-chrome-divider text-chrome-fg hover:border-chrome-fg hover:bg-chrome-fg hover:text-chrome transition-colors">
                        CONNECT EXTERNAL WALLET
                      </button>
                    );
                  }

                  if (chain.unsupported) {
                    return (
                      <button onClick={openChainModal} type="button" className="mako-button bg-mako-red text-white">
                        Wrong network
                      </button>
                    );
                  }

                  return (
                    <div className="flex flex-col gap-3">
                      <div className="bg-paper border-2 border-ink p-4 rounded-xl flex items-center justify-between gap-6 shadow-brutal-sm">
                        <div className="flex flex-col">
                          <span className="mako-label text-ink">EXTERNAL EOA</span>
                          <span className="mako-mono text-sm text-ink">{account.displayName}</span>
                        </div>
                        <div className="flex flex-col items-end">
                          <span className="mako-label text-muted">BALANCE</span>
                          <span className="mako-body font-bold text-ink">{account.displayBalance}</span>
                        </div>
                      </div>

                      <button
                        onClick={() => disconnect()}
                        className="mako-button mako-button--no self-start"
                      >
                        DISCONNECT WALLET
                      </button>
                    </div>
                  );
                }}
              </ConnectButton.Custom>
            </section>
            )}

            {/* Support Affordance */}
            <section className="flex flex-col items-start gap-4">
              <h3 className="mako-display text-xl text-chrome-fg">SUPPORT</h3>
              <p className="mako-body text-muted text-sm max-w-[220px] mb-1">
                Deposit missing or hit an error? We&apos;re here to help.
              </p>
              <a
                href={`mailto:support@makomarkets.com?subject=Mako%20Beta%20Support&body=Safe%20Address:%20${canonicalAddress ?? ''}%0A%0APlease%20describe%20your%20issue:%20`}
                className="font-display font-black uppercase tracking-widest text-sm px-8 py-4 border-2 border-chrome-divider text-chrome-fg hover:border-chrome-fg hover:bg-chrome-fg hover:text-chrome transition-colors w-full sm:w-auto text-center"
              >
                CONTACT SUPPORT
              </a>
            </section>
          </div>

          {(user || connectedWallet) && (
            <section className="flex flex-col sm:flex-row items-stretch sm:items-end justify-center lg:justify-end gap-3 w-full lg:w-auto mt-8 lg:mt-0">
              {(user || connectedWallet) && (
                <button
                  onClick={() => setActiveModal('switch')}
                  disabled={transitionInFlight}
                  className="font-display font-black uppercase tracking-widest text-sm px-8 py-4 border-2 border-chrome-divider text-chrome-fg hover:border-chrome-fg hover:bg-chrome-fg hover:text-chrome transition-colors text-center disabled:opacity-50"
                >
                  {switching ? 'SWITCHING…' : 'SWITCH ACCOUNT'}
                </button>
              )}
               <button
                onClick={handleSignOut}
                disabled={transitionInFlight}
                className="font-display font-black uppercase tracking-widest text-sm px-8 py-4 border-2 border-chrome-divider text-chrome-fg hover:border-chrome-fg hover:bg-chrome-fg hover:text-chrome transition-colors text-center disabled:opacity-50"
              >
                {signingOut ? 'SIGNING OUT…' : 'SIGN OUT'}
              </button>
            </section>
          )}
        </div>

      </div>

      {/* Reusable WarningModal for Export and Send flows */}
      <WarningModal
        open={activeModal === 'export'}
        onClose={() => setActiveModal('none')}
        onConfirm={handleExportKey}
        title="Warning"
        message="Anyone with this private key can drain your wallet. Are you sure you want to view it?"
        confirmLabel="VIEW PRIVATE KEY"
      />

      <WarningModal
        open={activeModal === 'send'}
        onClose={() => setActiveModal('none')}
        onConfirm={executeSend}
        title="CONFIRM SEND"
        message={`You are sending ${sendAmount} USDC to ${formatAddress(sendDestination)}.\n\nYour remaining balance will be ${(availableBalance - parseFloat(sendAmount || '0')).toFixed(2)} USDC.\n\nThis action cannot be undone.`}
        confirmLabel="SEND NOW"
      />

      <WarningModal
        open={activeModal === 'switch'}
        onClose={() => setActiveModal('none')}
        onConfirm={() => {
          setActiveModal('none');
          if (isMagicUser) {
            handleSwitchAccount();
          } else {
            handleSwitchWallet();
          }
        }}
        title="SWITCH ACCOUNT"
        message={
          isMagicUser
            ? `This signs you out of ${user?.email ?? 'this account'} and takes you to sign-in for a different email.\n\nYour wallet stays safe, only the active session changes.`
            : `This disconnects ${formatAddress(connectedWallet)} and takes you to sign-in. You can connect a different wallet or sign in with email there.\n\nYour funds stay safe, only the active connection changes.`
        }
        confirmLabel="SWITCH ACCOUNT"
      />
    </main>
  );
}
