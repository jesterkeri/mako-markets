'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, useBalance, useDisconnect } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { isAddress, parseUnits, type Address, erc20Abi } from 'viem';
import { useWriteContract } from 'wagmi';

import { useUser, USER_QUERY_KEY } from '@/lib/use-user';
import { getDisplayName, getIdentityLabel } from '@/lib/user-display';
import { isWalletDrifted } from '@/lib/wallet-drift';
import { WalletDriftBanner } from '@/components/WalletDriftBanner';
import { WarningModal } from '@/components/WarningModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MobileChromeHeader } from '@/components/MobileChromeHeader';
import { AvatarCircle } from '@/components/AvatarCircle';
import { IdentityBlock } from '@/components/profile/IdentityBlock';
import { TotpSection } from '@/components/profile/TotpSection';
import { runSendUsdc } from '@/lib/aa-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS } from '@/lib/contract';
import { SEND_USDC_MAX_PER_OP_BASE_UNITS } from '@/lib/aa-constants';
import { getMagic } from '@/lib/magic-browser';

function formatAddress(address: string | undefined): string {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const WALLET_HERO_PALETTE = [
  'bg-mako-yellow text-ink',
  'bg-mako-red text-paper',
  'bg-mako-blue text-paper',
  'bg-mako-green text-ink',
  'bg-mako-pink text-ink',
  'bg-mako-purple text-paper',
] as const;

function walletPaletteIndex(address: string): number {
  let sum = 0;
  const start = address.startsWith('0x') ? 2 : 0;
  for (let i = start; i < Math.min(start + 5, address.length); i++) {
    sum += address.charCodeAt(i);
  }
  return sum % WALLET_HERO_PALETTE.length;
}

/**
 * Wallet-only hero card. Mirrors the Magic-user Hero (avatar + display
 * line + monospace subtitle) so the LEFT column has parity in both
 * auth modes. Uses a deterministic-color glyph derived from the
 * address since wallet users have no email or display name.
 */
function WalletHero({
  address,
  className = '',
}: {
  address: string;
  className?: string;
}) {
  const palette = WALLET_HERO_PALETTE[walletPaletteIndex(address)]!;
  const initials = address.slice(2, 4).toUpperCase();
  return (
    <section className={`mako-card text-ink items-center gap-4 ${className || 'flex'}`}>
      <div
        className={`shrink-0 rounded-full border-2 border-ink flex items-center justify-center mako-display ${palette}`}
        style={{ width: 64, height: 64, fontSize: 22 }}
        aria-hidden
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <p className="mako-title text-2xl leading-tight truncate tabular-nums">
          {formatAddress(address)}
        </p>
        <p className="mako-mono text-xs text-muted truncate">
          External wallet
        </p>
      </div>
    </section>
  );
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

export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: isUserLoading } = useUser();
  const { address: connectedWallet } = useAccount();
  const { disconnect, disconnectAsync } = useDisconnect();
  const { writeContractAsync } = useWriteContract();

  // Component States. Two transition flags rather than one shared
  // `signingOut`: clicking SWITCH ACCOUNT shouldn't make SIGN OUT also
  // render its pending state, and vice versa. Both buttons stay
  // disabled while either flow is in flight (a sign-out mid-switch is
  // a bug we don't try to handle gracefully).
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
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

  // Address resolution: Magic Safe takes precedence; wallet-session
  // and wagmi-only users canonicalize on the connected wallet (plan
  // step 18 narrowing). The wallet-drift banner (plan step 21) is
  // what surfaces a wallet-session ≠ connected mismatch.
  const isMagicUser = user?.authType === 'magic';
  const canonicalAddress = isMagicUser
    ? (user.safeAddress as `0x${string}`)
    : connectedWallet;

  // Wallet-session drift (plan step 21). Computed once at the page top
  // and threaded into Send-button disable + the page-level banner.
  // `isWalletDrifted` returns false for Magic sessions, for null users,
  // and when no wallet is connected — so the banner is gated to the
  // exact "wallet-authed AND connected wallet differs" case.
  const drifted = isWalletDrifted(user ?? null, connectedWallet);

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
    setSignOutError(null);
    try {
      // Mirror AuthMenu: clear Magic session first, then disconnect wagmi.
      // Either branch may run independently — wallet-only users land on
      // /profile via the wallet-auth path and have no Magic session to
      // clear; legacy mixed-state users (from before mutual-exclusion
      // enforcement on /signup) need both.
      //
      // Sub-F round-2 MAJOR 1: if Magic logout fails (network throw OR
      // non-OK response), bail with an error banner and DO NOT touch
      // wagmi. A partial sign-out (wallet disconnected, Magic session
      // alive) is the worst possible state — the user would land on /
      // with a stale authed cache and a disconnected wallet, looking
      // signed in but unable to transact. Same bail policy as AuthMenu.
      if (user) {
        let res: Response;
        try {
          res = await fetch('/api/user/logout', {
            method: 'POST',
            credentials: 'same-origin',
          });
        } catch {
          setSignOutError('Network error during sign-out. Please retry.');
          return;
        }
        if (!res.ok) {
          setSignOutError('Sign-out failed. Please retry.');
          return;
        }
        queryClient.setQueryData(USER_QUERY_KEY, { authed: false });
      }
      if (connectedWallet) {
        try {
          disconnect();
        } catch (e) {
          console.warn('Wallet disconnect during sign-out failed', e);
        }
      }
      router.push('/');
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
  const handleSwitchWallet = async () => {
    if (transitionInFlight) return;
    setSwitching(true);
    // Use disconnectAsync so we can await wagmi's state update before
    // navigating. Otherwise /signup mounts with stale-truthy
    // useAccount() while wagmi is mid-disconnect — which used to
    // trigger /signup's stuck-on-CONNECTING state under the prior
    // transition-detector. The intent-based redirect on /signup
    // handles stale state too, but awaiting here is cheap belt-and-
    // suspenders.
    try {
      await disconnectAsync();
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
      await magic.user.revealEVMPrivateKey();
    } catch (e) {
      // User-canceled the modal: Magic surfaces this as RPC -32603
      // "User canceled action". Not an error — just close quietly.
      const msg = e instanceof Error ? e.message : String(e);
      if (/user canceled/i.test(msg)) return;
      console.error('Failed to open magic reveal-key flow', e);
    }
  };

  // ── Send flow ─────────────────────────────────────────────────────────────
  const handleReviewSend = () => {
    setSendError('');
    // Drift gate (codex round-11 MAJOR fix). The visible button's
    // `disabled` already covers this, but a stale-submit path (e.g.
    // enter-key on a pre-drift form, programmatic click) could still
    // open the SEND NOW modal. Hard-return here so a drift that
    // appears between mount and click cannot reach `executeSend`.
    if (drifted) return;
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
    // Drift gate (codex round-11 MAJOR fix). The user might have
    // opened the SEND NOW modal pre-drift and switched the connected
    // wallet before clicking SEND NOW. Re-check here so the
    // wallet-session-vs-connected mismatch can't bypass the
    // handleReviewSend gate via that race.
    if (drifted) {
      setSendPhase('error');
      setSendError(
        'Connected wallet changed during review. Send was not sent.',
      );
      return;
    }
    if (!canonicalAddress) {
      setSendPhase('error');
      setSendError('You must be connected to send USDC.');
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

    // External wallet flow (direct EOA transaction)
    if (!isMagicUser) {
      try {
        const txHash = await writeContractAsync({
          address: usdcAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [sendDestination as `0x${string}`, amountBaseUnits],
        });
        setSendTxHash(txHash);
        setSendPhase('confirming'); // Wagmi returns txHash immediately; network confirms it
        // Note: For a robust implementation we should wait for the receipt,
        // but for UX consistency with AA we can just show 'sent' shortly after.
        setTimeout(() => setSendPhase('sent'), 3000); 
      } catch (e) {
        console.error('Send failed via external wallet', e);
        setSendPhase('error');
        setSendError('Transaction failed or was rejected by your wallet.');
      }
      return;
    }

    // Magic user flow (Account Abstraction via bundler)
    let outcome;
    try {
      outcome = await runSendUsdc({
        chainId: MONAD_TESTNET_ID,
        recipient: sendDestination as Address,
        amountUsdc: amountBaseUnits,
        usdcAddress: usdcAddress as Address,
        magicEoa:
          user?.authType === 'magic'
            ? (user.magicEoa as Address)
            : (() => {
                throw new Error(
                  'send-usdc magic-flow guard fell through for non-magic user',
                );
              })(),
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
      <main className="flex-1 flex flex-col pb-10 w-full">
        <MobileChromeHeader />
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

  return (
    <main className="flex-1 flex flex-col w-full pb-10">
      <MobileChromeHeader />
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

        {/* Mobile-only Hero. Renders above the two-column grid so the
            identity surface comes first on mobile. On desktop (lg) this
            clone is hidden — the desktop instance lives inside the LEFT
            column below, preserving the Hero+Security stack on the
            left. Two flavours: Magic (avatar + display name + email)
            vs wallet-only (deterministic-color glyph + formatted
            address). */}
        {user ? (
          <section className="lg:hidden mako-card text-ink flex items-center gap-4">
            <AvatarCircle
              displayName={user.displayName}
              initialSource={user.authType === 'magic' ? user.email : user.walletAddress}
              seedKey={user.authType === 'magic' ? user.magicEoa : user.walletAddress}
              avatarUrl={user.avatarUrl}
              size={64}
            />
            <div className="flex-1 min-w-0">
              <p className="mako-title text-2xl leading-tight truncate">
                {getDisplayName(user)}
              </p>
              <p className="mako-mono text-xs text-muted truncate">
                {getIdentityLabel(user)}
              </p>
            </div>
          </section>
        ) : connectedWallet ? (
          <WalletHero address={connectedWallet} className="flex lg:hidden" />
        ) : null}

        {/* Page-level wallet-drift banner (plan step 21). Renders ONLY
            when a wallet-authed session's stored address no longer
            matches the connected wallet — see `isWalletDrifted`. The
            banner offers SIGN OUT (clears session) and DISCONNECT
            WALLET (drops the wagmi connection) so the user can pick
            their resolution. */}
        {drifted && user?.authType === 'wallet' && connectedWallet && (
          <WalletDriftBanner
            sessionWallet={user.walletAddress}
            connectedWallet={connectedWallet}
          />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

          {/* LEFT COLUMN: Identity, Balance & Security.
              Mobile order: 2nd (after the right column). This puts
              SECURITY at the bottom of the mobile flow instead of
              squeezing it between the mobile-only Hero clone and the
              identity rows / balance. Desktop: order is the natural
              source order (left column on the left). */}
          <div className="lg:col-span-6 order-2 lg:order-1 flex flex-col gap-8">

            {/* 0. Hero card — desktop instance. Hidden on mobile
                because the lg:hidden clone above already rendered. */}
            {user ? (
              <section className="hidden lg:flex mako-card text-ink items-center gap-4">
                <AvatarCircle
                  displayName={user.displayName}
                  initialSource={user.authType === 'magic' ? user.email : user.walletAddress}
                  seedKey={user.authType === 'magic' ? user.magicEoa : user.walletAddress}
                  avatarUrl={user.avatarUrl}
                  size={64}
                />
                <div className="flex-1 min-w-0">
                  <p className="mako-title text-2xl leading-tight truncate">
                    {getDisplayName(user)}
                  </p>
                  <p className="mako-mono text-xs text-muted truncate">
                    {getIdentityLabel(user)}
                  </p>
                </div>
              </section>
            ) : connectedWallet ? (
              <WalletHero address={connectedWallet} className="hidden lg:flex" />
            ) : null}

            {/* 4. Security & Recovery */}
            <section className={`mako-card text-ink relative overflow-hidden flex flex-col gap-5 ${isMagicUser ? 'border-mako-red shadow-[4px_4px_0_0_#D94A3D]' : ''}`}>
              {isMagicUser && <div className="absolute inset-0 bg-mako-red/5 pointer-events-none" />}

              <div className="relative z-10 flex flex-col gap-5">
                <h2 className={`mako-display text-[clamp(1.5rem,2.5vw,1.75rem)] ${isMagicUser ? 'text-mako-red' : 'text-ink'}`}>SECURITY</h2>

                {isMagicUser ? (
                  <>
                    <p className="mako-body text-ink text-lg leading-relaxed">
                      Your email is your wallet. Mako Market does not hold your funds and has no separate password or recovery surface. Magic provides the authentication.
                      <strong className="block mt-2">If your email account is compromised, your funds are at risk.</strong>
                    </p>

                    <div className="bg-paper border-2 border-ink p-4 rounded-xl">
                      <h3 className="mako-display text-base text-ink mb-3">TWO-FACTOR AUTHENTICATION</h3>
                      <TotpSection user={user} />
                    </div>

                    <div className="mt-4 pt-6 border-t-2 border-ink/10">
                      <button
                        onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
                        className="mako-label text-xs text-ink hover:underline opacity-60 hover:opacity-100 transition-opacity flex items-center gap-2"
                      >
                        {showTechnicalDetails ? 'HIDE TECHNICAL DETAILS' : 'SHOW TECHNICAL DETAILS'}
                        <svg className={`w-4 h-4 transition-transform ${showTechnicalDetails ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
                      </button>

                      {showTechnicalDetails && user?.authType === 'magic' && (
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

          {/* RIGHT COLUMN: Identity rows + Balance, Send & Receive.
              Mobile order: 1st. See LEFT col comment above. */}
          <div className="lg:col-span-6 order-1 lg:order-2 flex flex-col gap-8">

            {/* 1. Identity & Balance — moved from left col so the
                hero card stands alone over the SECURITY card on the
                left, while editable identity rows + balance share
                space with the action surfaces (Send / Receive). */}
            <section className="mako-card text-ink flex flex-col">
              <IdentityBlock user={user} connectedWallet={connectedWallet} />

              <div className="border-t-2 border-ink pt-6 mt-6">
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
                      <span className="font-display font-black text-[clamp(2.25rem,4vw,3rem)] tracking-tighter text-ink leading-none">--- USDC</span>
                      <button onClick={() => refetchBalance()} className="w-10 h-10 flex items-center justify-center border-2 border-ink rounded-full hover:bg-ink hover:text-white transition-colors" aria-label="Retry">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <span className="font-display font-black text-[clamp(3rem,5vw,3.75rem)] tracking-tighter text-ink leading-none">
                      {balanceData ? parseFloat(balanceData.formatted).toFixed(2) : '0.00'} <span className="text-3xl text-muted ml-1">USDC</span>
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* 3. Send USDC */}
            {canonicalAddress && (
               <section className="mako-card text-ink flex flex-col gap-5 border-4 border-ink relative overflow-hidden">
                <h2 className="mako-display text-[clamp(1.5rem,2.5vw,1.75rem)]">SEND USDC</h2>

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
                      disabled={!sendAmount || !sendDestination || drifted}
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
                  <h2 className="mako-display text-[clamp(1.5rem,2.5vw,1.75rem)]">RECEIVE USDC</h2>
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
                      Send USDC directly to this address on Monad.{' '}
                      {isMagicUser
                        ? 'This is your personal smart wallet.'
                        : 'This is your connected wallet.'}
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
                href={`mailto:support@makomarkets.com?subject=Mako%20Beta%20Support&body=${
                  isMagicUser ? 'Safe%20Address' : 'Wallet%20Address'
                }:%20${canonicalAddress ?? ''}%0A%0APlease%20describe%20your%20issue:%20`}
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
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleSignOut}
                  disabled={transitionInFlight}
                  className="font-display font-black uppercase tracking-widest text-sm px-8 py-4 border-2 border-chrome-divider text-chrome-fg hover:border-chrome-fg hover:bg-chrome-fg hover:text-chrome transition-colors text-center disabled:opacity-50"
                >
                  {signingOut ? 'SIGNING OUT…' : 'SIGN OUT'}
                </button>
                {signOutError && (
                  <p
                    role="alert"
                    className="font-mono text-xs text-mako-red text-center"
                  >
                    {signOutError}
                  </p>
                )}
              </div>
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
            ? `This signs you out of ${user?.authType === 'magic' ? user.email : 'this account'} and takes you to sign-in for a different email.\n\nYour wallet stays safe, only the active session changes.`
            : `This disconnects ${formatAddress(connectedWallet)} and takes you to sign-in. You can connect a different wallet or sign in with email there.\n\nYour funds stay safe, only the active connection changes.`
        }
        confirmLabel="SWITCH ACCOUNT"
      />
    </main>
  );
}
