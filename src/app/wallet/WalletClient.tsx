'use client';

import Link from 'next/link';
import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

import { CopyButton, display, mono, BAR } from '@/app/me/MeParts';
import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';
import { SignInLink } from '@/components/signin/SignInLink';
import { useUsdcBalance } from '@/lib/hooks';
import { CIRCLE_FAUCET_URL } from '@/lib/list-states';
import { usdc2 } from '@/lib/pool-list';
import { formatAddress } from '@/lib/user-display';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';
import { EMAIL_SEND_CAP, exactUsdc, maxSend, useWalletSend } from '@/lib/use-wallet-send';
import { formatUnits } from 'viem';

// Wallet: send USDC, or show the address to receive it. Composed from the redesign's parts: Settings' rows and
// pills on desktop, Me's M3 tiles on mobile, and the confirm-in-wallet sheet (19a) for the send itself.

export type WalletTab = 'send' | 'receive';

const TABS: { key: WalletTab; label: string }[] = [
  { key: 'send', label: 'Send' },
  { key: 'receive', label: 'Receive' },
];

const note: React.CSSProperties = { fontSize: 13, color: 'var(--dim)', lineHeight: 1.45 };
const pill: React.CSSProperties = { height: 30, padding: '0 12px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', whiteSpace: 'nowrap' };
const input: React.CSSProperties = { height: 48, width: '100%', boxSizing: 'border-box', padding: '0 14px', border: 0, outline: 0, borderRadius: 12, background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', color: 'var(--mako-canvas-fg)', fontSize: 16 };

export function WalletClient({ initialTab }: { initialTab: WalletTab }) {
  const { user, isLoading, isError, refetch } = useUser();
  if (user) return <WalletSignedIn user={user} initialTab={initialTab} />;
  return <WalletGate kind={isLoading ? 'loading' : isError ? 'error' : 'signed-out'} onRetry={() => void refetch()} />;
}

function WalletSignedIn({ user, initialTab }: { user: AuthedUser; initialTab: WalletTab }) {
  const [tab, setTab] = useState<WalletTab>(initialTab);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const email = user.authType === 'magic';
  const account = accountAddress(user);
  const balanceQuery = useUsdcBalance(account);
  const balance = typeof balanceQuery.data === 'bigint' ? balanceQuery.data : undefined;
  const send = useWalletSend(
    user,
    balance,
    () => {
      setTo('');
      setAmount('');
      void balanceQuery.refetch();
    },
    () => void balanceQuery.refetch(),
  );

  const balanceText = balance !== undefined ? `${usdc2(balance)} USDC` : balanceQuery.isError ? 'Balance unavailable' : '…';
  const gasLine = email ? `Gas-free with email. Up to ${usdc2(EMAIL_SEND_CAP)} USDC a send.` : 'Your wallet pays the gas, in MON.';

  const onReview = () => {
    setError(send.review({ to, amount }) ?? '');
  };
  const onMax = () => {
    if (balance !== undefined) setAmount(formatUnits(maxSend(balance, email), 6));
  };

  const spec: ConfirmSpec | null = send.reviewed && {
    glyph: '↗',
    glyphColor: 'var(--mako-signal)',
    title: 'Send USDC',
    confirmLabel: 'Send',
    pendingTitle: 'Sending USDC',
    rows: [
      // Exactly what is sent: the unrounded amount and the full address (adversary on e442601).
      { label: 'Amount', value: `${exactUsdc(send.reviewed.amount)} USDC` },
      { label: 'To', value: send.reviewed.to },
      { label: 'Network', value: 'Monad testnet' },
      { label: 'Gas', value: email ? 'Covered by Mako Market' : 'Paid by your wallet' },
    ],
    note: 'A send can’t be undone. Check the address: USDC sent to the wrong one is gone.',
    doneTitle: 'Sent',
    doneBody: `${exactUsdc(send.reviewed.amount)} USDC left your wallet for ${send.reviewed.to}.`,
  };

  const tabs = (mobile: boolean) => (
    <div role="tablist" aria-label="Send or receive" style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 9999, background: 'var(--raise)', ...(mobile ? { width: '100%' } : {}) }}>
      {TABS.map((t) => {
        const on = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => setTab(t.key)}
            style={{ height: mobile ? 40 : 30, flex: mobile ? 1 : undefined, padding: '0 16px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'transparent', color: on ? 'var(--mako-canvas)' : 'var(--dim)', ...(mobile ? { fontSize: 15, fontWeight: 700 } : { ...mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const }) }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );

  const sendForm = (mobile: boolean) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onReview();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={mobile ? { fontSize: 14, fontWeight: 700 } : { ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>To</span>
        <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} aria-label="Recipient address" style={{ ...input, ...mono, fontSize: 14 }} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={mobile ? { fontSize: 14, fontWeight: 700 } : { ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Amount, USDC</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} inputMode="decimal" placeholder="0.00" aria-label="Amount in USDC" style={{ ...input, ...display, fontSize: 20, flex: 1 }} />
          <button type="button" onClick={onMax} disabled={balance === undefined} className="mk-press96" style={{ ...pill, height: 48, padding: '0 16px' }}>
            Max
          </button>
        </span>
      </label>
      <span style={note}>{gasLine}</span>
      {error && (
        <span role="alert" style={{ ...note, color: 'var(--mako-red)' }}>
          {error}
        </span>
      )}
      <button type="submit" className={mobile ? 'm3-press' : 'mk-press97'} style={{ height: mobile ? 56 : 48, padding: '0 24px', alignSelf: mobile ? 'stretch' : 'flex-end', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 16 }}>
        Review send
      </button>
    </form>
  );

  const receive = (mobile: boolean) => (
    <div style={{ display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'flex-start', gap: mobile ? 16 : 28 }}>
      <div style={{ alignSelf: 'center', padding: 14, borderRadius: mobile ? 24 : 14, background: '#fff', boxShadow: 'var(--edge)', lineHeight: 0 }}>
        <QRCodeSVG value={account} size={mobile ? 200 : 168} bgColor="#ffffff" fgColor="#000000" level="M" aria-label="QR code of your wallet address" />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, flex: 1 }}>
        <div style={{ ...mono, fontSize: mobile ? 14 : 13, fontWeight: 700, wordBreak: 'break-all', lineHeight: 1.5 }}>{account}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <CopyButton text={account} className={mobile ? 'm3-press' : 'mk-press96'} style={{ ...pill, ...(mobile ? { height: 44, padding: '0 18px', fontSize: 13 } : {}) }}>
            {(copied) => (copied ? 'Copied' : 'Copy address')}
          </CopyButton>
          <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noopener noreferrer" className={mobile ? 'm3-press' : 'mk-press96'} style={{ ...pill, ...(mobile ? { height: 44, padding: '0 18px', fontSize: 13 } : {}) }}>
            Get test USDC ↗
          </a>
        </div>
        <span style={note}>Send only USDC on Monad testnet to this address. Anything else, or USDC on another network, may be lost.</span>
        {email && <span style={note}>This is your Mako wallet. It can receive USDC before its first transaction.</span>}
      </div>
    </div>
  );

  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <div style={{ maxWidth: 720, padding: '22px 4px 48px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <h1 style={{ margin: 0, ...display, fontSize: 48, lineHeight: 1, letterSpacing: '-0.04em' }}>Wallet</h1>
            {tabs(false)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: 16, alignItems: 'center', padding: '16px 0', marginTop: 18, boxShadow: 'inset 0 1px 0 var(--line), inset 0 -1px 0 var(--line)' }}>
            <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Balance</span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <strong style={{ ...mono, fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{balanceText}</strong>
              <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>MONAD TESTNET</span>
            </span>
          </div>
          <div role="tabpanel" style={{ paddingTop: 22 }}>
            {tab === 'send' ? sendForm(false) : receive(false)}
          </div>
        </div>
      </div>

      <div className="mk-mob mk-m">
        <div style={{ padding: '6px 16px 120px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Link href="/me" aria-label="Back to Me" className="m3-press" style={{ width: 44, height: 44, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'inherit', textDecoration: 'none', fontSize: 18 }}>
              ‹
            </Link>
            <h1 style={{ margin: 0, flex: 1, textAlign: 'center', ...display, fontSize: 26, letterSpacing: '-0.02em' }}>Wallet</h1>
            <span style={{ width: 44 }} />
          </div>
          <div style={{ marginTop: 16, borderRadius: 28, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '18px 20px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, opacity: 0.75 }}>Balance</div>
            <div style={{ ...display, fontSize: 34, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', marginTop: 4 }}>{balanceText}</div>
            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>Monad testnet · {formatAddress(account)}</div>
          </div>
          <div style={{ marginTop: 16 }}>{tabs(true)}</div>
          <div role="tabpanel" style={{ marginTop: 18 }}>
            {tab === 'send' ? sendForm(true) : receive(true)}
          </div>
        </div>
      </div>

      {spec && send.reviewed && (
        <ConfirmSheet
          spec={spec}
          phase={send.phase}
          wallet={{ kind: email ? 'mako' : 'external', address: account }}
          onConfirm={() => void send.confirm()}
          onCancel={send.close}
          onRetry={send.retry}
          onClose={send.close}
        />
      )}
    </>
  );
}

function WalletGate({ kind, onRetry }: { kind: 'loading' | 'signed-out' | 'error'; onRetry: () => void }) {
  if (kind === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading" style={{ padding: '28px 16px' }}>
        <div style={{ width: 200, height: 44, borderRadius: 10, background: BAR }} />
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: '100%', maxWidth: 720, height: 18, borderRadius: 8, background: BAR, marginTop: 22 }} />
        ))}
      </div>
    );
  }
  const error = kind === 'error';
  const button: React.CSSProperties = { height: 52, display: 'inline-flex', alignItems: 'center', padding: '0 24px', marginTop: 22, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', ...display, fontSize: 16, textDecoration: 'none' };
  return (
    <div role={error ? 'alert' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '72px 16px 80px' }}>
      <h1 style={{ margin: 0, ...display, fontSize: 44, lineHeight: 1, letterSpacing: '-0.04em' }}>{error ? 'Can’t check your sign-in' : 'Wallet'}</h1>
      <p style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--dim)', marginTop: 12, maxWidth: 480 }}>
        {error ? 'Mako Market couldn’t reach its server just now. Your balance is safe on-chain.' : 'Sign in to send USDC or show your address to receive it.'}
      </p>
      {error ? (
        <button type="button" onClick={onRetry} className="mk-press97" style={button}>
          Try again
        </button>
      ) : (
        <SignInLink className="mk-press97" style={button}>
          Sign in
        </SignInLink>
      )}
    </div>
  );
}
