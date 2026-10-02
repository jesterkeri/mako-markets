'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useBlockNumber } from 'wagmi';

import { CopyButton, display, mono, BAR } from '@/app/me/MeParts';
import { useEmbeddedActions } from '@/components/PrivyAuth';
import { RegenerateRecoveryCodesModal } from '@/components/profile/RegenerateRecoveryCodesModal';
import { TotpDisableModal } from '@/components/profile/TotpDisableModal';
import { TotpEnrollmentModal } from '@/components/profile/TotpEnrollmentModal';
import { maskEmail } from '@/components/shell/SignOutConfirm';
import { openSignOut } from '@/lib/sign-out-store';
import { SignInLink } from '@/components/signin/SignInLink';
import { tourHref } from '@/lib/tour';
import { formatAddress } from '@/lib/user-display';
import { useTheme, type ThemePreference } from '@/lib/use-theme';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';

// Settings (21a). Account, security, appearance, network and sign out. What the product does not do yet
// (notifications) is shown as coming soon, never as a working switch. Security follows the
// design corrections list: two-factor authentication and key export for email accounts.

const SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'security', label: 'Security' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'network', label: 'Network' },
] as const;

const NOTIFICATION_KINDS: [string, string][] = [
  ['Round starting', 'A round you follow opens for entries'],
  ['Entries closing', 'Before entries close on your rounds'],
  ['You won', 'A round or pool you are in settles in your favour'],
  ['Pool results', 'A pool you bet on is settled or refunded'],
  ['Replies', 'Someone replies to your comment'],
];

const THEMES: { key: ThemePreference; label: string }[] = [
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
  { key: 'auto', label: 'System' },
];

/// "1 Oct 2026, 09:12", in the viewer's own time.
const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export function SettingsClient() {
  const { user, isLoading, isError, refetch } = useUser();
  if (user) return <SettingsSignedIn user={user} />;
  return <SettingsGate kind={isLoading ? 'loading' : isError ? 'error' : 'signed-out'} onRetry={() => void refetch()} />;
}

function SettingsSignedIn({ user }: { user: AuthedUser }) {
  const { preference, setPreference } = useTheme();
  const { data: block } = useBlockNumber({ watch: true });
  const { exportKey } = useEmbeddedActions();
  const [modal, setModal] = useState<'enroll' | 'disable' | 'regenerate' | null>(null);
  const [exportError, setExportError] = useState('');

  const email = user.authType === 'magic';
  const account = accountAddress(user);
  const name = user.displayName?.trim() || null;

  const runExport = async () => {
    setExportError('');
    try {
      // Only an email account has an embedded key; its signer is the wallet the account records.
      if (user.authType !== 'magic') return;
      await exportKey(user.magicEoa);
    } catch (e) {
      setExportError(e instanceof Error && e.message ? e.message : 'The key could not be shown. Try again.');
    }
  };

  const pill: React.CSSProperties = { height: 30, padding: '0 12px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', whiteSpace: 'nowrap' };
  const note: React.CSSProperties = { fontSize: 13, color: 'var(--dim)', lineHeight: 1.45 };

  const rows: Record<(typeof SECTIONS)[number]['id'], { k: string; v: React.ReactNode }[]> = {
    account: [
      { k: 'Signed in with', v: <strong>{email ? `Email · ${maskEmail(user.email)}` : `Wallet · ${formatAddress(user.walletAddress)}`}</strong> },
      {
        k: 'Wallet',
        v: (
          <>
            <span style={{ ...mono, fontSize: 13, fontWeight: 700 }}>{formatAddress(account)}</span>
            <CopyButton text={account} className="mk-press96" style={pill} />
            <span style={note}>{email ? 'Created at sign-in. Nothing to back up.' : 'Your own wallet. Mako Market never holds its key.'}</span>
          </>
        ),
      },
      {
        k: 'Username',
        v: (
          <>
            <strong>{name ?? 'Not set'}</strong>
            <Link href="/me" style={{ ...note, color: 'var(--mako-canvas-fg)', textDecoration: 'underline' }}>
              Change it on Me
            </Link>
          </>
        ),
      },
      {
        k: 'Send and receive',
        v: (
          <>
            <Link href="/profile" className="mk-press96" style={pill}>
              Open
            </Link>
            <span style={note}>Send USDC or show your address to receive it.</span>
          </>
        ),
      },
      {
        k: 'How to play',
        v: (
          <>
            <Link href={tourHref(0)} className="mk-press96" style={pill}>
              Replay tour
            </Link>
            <span style={note}>The 7-step intro to Mako Market.</span>
          </>
        ),
      },
      {
        k: 'Legal',
        v: (
          <>
            <Link href="/legal" className="mk-press96" style={pill}>
              Open
            </Link>
            <span style={note}>Terms, privacy and risk notice.</span>
          </>
        ),
      },
    ],
    security: email
      ? [
          {
            k: 'Two-factor',
            v: user.totpEnabled ? (
              <>
                <strong>On{user.totpEnabledAt ? ` since ${when(user.totpEnabledAt)}` : ''}</strong>
                <button type="button" onClick={() => setModal('regenerate')} className="mk-press96" style={pill}>
                  New recovery codes
                </button>
                <button type="button" onClick={() => setModal('disable')} className="mk-press96" style={{ ...pill, color: 'var(--mako-red)' }}>
                  Turn off
                </button>
              </>
            ) : (
              <>
                <strong>Off</strong>
                <button type="button" onClick={() => setModal('enroll')} className="mk-press96" style={{ ...pill, background: 'var(--mako-signal)', color: '#000' }}>
                  Turn on
                </button>
                <span style={note}>A 6-digit code from an authenticator app, asked at every sign-in.</span>
              </>
            ),
          },
          {
            k: 'Export key',
            v: (
              <>
                <button type="button" onClick={() => void runExport()} className="mk-press96" style={pill}>
                  Show private key
                </button>
                <span style={note}>The key that signs for your account. Anyone who has it controls your USDC.</span>
                {exportError && (
                  <span role="alert" style={{ ...note, color: 'var(--mako-red)', flexBasis: '100%' }}>
                    {exportError}
                  </span>
                )}
              </>
            ),
          },
          { k: 'Last sign-in', v: <span style={note}>{user.lastSignInAt ? `Before this one: ${when(user.lastSignInAt)}` : 'This is your first sign-in.'}</span> },
        ]
      : [
          { k: 'Security', v: <span style={note}>Your wallet keeps your key and approves every transaction.</span> },
          { k: 'Last sign-in', v: <span style={note}>{user.lastSignInAt ? `Before this one: ${when(user.lastSignInAt)}` : 'This is your first sign-in.'}</span> },
        ],
    notifications: NOTIFICATION_KINDS.map(([k, d]) => ({
      k,
      v: (
        <>
          <span style={note}>{d}</span>
          <span role="switch" aria-checked="false" aria-disabled="true" aria-label={`${k}, coming soon`} style={{ marginLeft: 'auto', width: 38, height: 22, borderRadius: 9999, background: BAR, opacity: 0.55, position: 'relative', flex: 'none' }}>
            <span style={{ position: 'absolute', top: 3, left: 3, width: 16, height: 16, borderRadius: '50%', background: 'var(--dim)' }} />
          </span>
        </>
      ),
    })),
    appearance: [
      {
        k: 'Theme',
        v: (
          <div role="radiogroup" aria-label="Theme" style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 9999, background: 'var(--raise)' }}>
            {THEMES.map((t) => {
              const on = preference === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPreference(t.key)}
                  style={{ height: 28, padding: '0 14px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'transparent', color: on ? 'var(--mako-canvas)' : 'var(--dim)', ...mono, fontSize: 11, fontWeight: 700 }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        ),
      },
    ],
    network: [
      {
        k: 'Chain',
        v: (
          <>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--mako-signal)' }} />
            <strong>Monad testnet</strong>
            <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>{block !== undefined ? `BLOCK ${block.toLocaleString('en-US')}` : 'BLOCK …'}</span>
          </>
        ),
      },
      {
        k: 'Gas',
        v: email ? (
          <>
            <strong>Covered by Mako Market</strong>
            <span style={note}>Up to 10 transactions a day.</span>
          </>
        ) : (
          <strong>Paid by your wallet, in MON</strong>
        ),
      },
    ],
  };

  const signOutNote = email ? 'Your wallet and balance stay safe. Sign in with the same email to get back.' : 'Your funds stay in your wallet.';

  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0, 640px)', gap: 40, padding: '22px 4px 48px' }}>
          <nav aria-label="Settings sections" style={{ position: 'sticky', top: 20, alignSelf: 'start', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="wm-row" style={{ height: 32, display: 'flex', alignItems: 'center', padding: '0 12px', borderRadius: 9999, ...mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--mako-canvas-fg)', textDecoration: 'none' }}>
                {s.label}
              </a>
            ))}
          </nav>
          <div>
            <h1 style={{ margin: 0, ...display, fontSize: 48, lineHeight: 1, letterSpacing: '-0.04em' }}>Settings</h1>
            {SECTIONS.map((s) => (
              <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} style={{ marginTop: 34, scrollMarginTop: 20 }}>
                <h2 id={`${s.id}-h`} style={{ margin: '0 0 6px', ...display, fontSize: 22, letterSpacing: '-0.02em' }}>
                  {s.label}
                  {s.id === 'notifications' && <span style={{ ...mono, fontSize: 11, fontWeight: 700, color: 'var(--dim)', marginLeft: 10 }}>COMING SOON</span>}
                </h2>
                {rows[s.id].map((r) => (
                  <div key={r.k} style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: 16, alignItems: 'center', padding: '13px 0', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
                    <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{r.k}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 14 }}>{r.v}</div>
                  </div>
                ))}
              </section>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 30 }}>
              <button type="button" onClick={() => openSignOut(user)} className="mk-press96" style={{ height: 40, padding: '0 18px', borderRadius: 9999, boxShadow: 'inset 0 0 0 1.5px var(--mako-red)', color: 'var(--mako-red)', fontSize: 14, fontWeight: 800 }}>
                Sign out
              </button>
              <span style={note}>{signOutNote}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mk-mob mk-m">
        <div style={{ padding: '6px 16px 120px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Link href="/me" aria-label="Back to Me" className="m3-press" style={{ width: 40, height: 40, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'inherit', textDecoration: 'none', fontSize: 18 }}>
              ‹
            </Link>
            <h1 style={{ margin: 0, ...display, fontSize: 26, letterSpacing: '-0.02em' }}>Settings</h1>
          </div>
          {SECTIONS.map((s) => (
            <section key={s.id} aria-labelledby={`${s.id}-mh`} style={{ marginTop: 22 }}>
              <h2 id={`${s.id}-mh`} style={{ margin: '0 0 8px 4px', fontSize: 14, fontWeight: 700, color: 'var(--dim)' }}>
                {s.label}
                {s.id === 'notifications' && ' · coming soon'}
              </h2>
              <div style={{ borderRadius: 24, background: 'var(--raise)', padding: '2px 14px' }}>
                {rows[s.id].map((r, i) => (
                  <div key={r.k} style={{ padding: '12px 0', boxShadow: i < rows[s.id].length - 1 ? 'inset 0 -1px 0 var(--line)' : undefined }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{r.k}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 14 }}>{r.v}</div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <button type="button" onClick={() => openSignOut(user)} className="m3-press" style={{ width: '100%', height: 52, marginTop: 24, borderRadius: 9999, boxShadow: 'inset 0 0 0 1.5px var(--mako-red)', color: 'var(--mako-red)', fontSize: 16, fontWeight: 800 }}>
            Sign out
          </button>
          <div style={{ ...note, textAlign: 'center', marginTop: 10 }}>{signOutNote}</div>
        </div>
      </div>

      {email && (
        <>
          <TotpEnrollmentModal open={modal === 'enroll'} onClose={() => setModal(null)} />
          <TotpDisableModal open={modal === 'disable'} onClose={() => setModal(null)} />
          <RegenerateRecoveryCodesModal open={modal === 'regenerate'} onClose={() => setModal(null)} />
        </>
      )}
    </>
  );
}

function SettingsGate({ kind, onRetry }: { kind: 'loading' | 'signed-out' | 'error'; onRetry: () => void }) {
  if (kind === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading" style={{ padding: '28px 16px' }}>
        <div style={{ width: 220, height: 44, borderRadius: 10, background: BAR }} />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ width: '100%', maxWidth: 640, height: 18, borderRadius: 8, background: BAR, marginTop: 22 }} />
        ))}
      </div>
    );
  }
  const error = kind === 'error';
  return (
    <div role={error ? 'alert' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '72px 16px 80px' }}>
      <h1 style={{ margin: 0, ...display, fontSize: 44, lineHeight: 1, letterSpacing: '-0.04em' }}>{error ? 'Can’t check your sign-in' : 'Settings'}</h1>
      <p style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--dim)', marginTop: 12, maxWidth: 480 }}>
        {error ? 'Mako Market couldn’t reach its server just now. Your balance and bets are safe on-chain.' : 'Sign in to manage your account, security and appearance.'}
      </p>
      {error ? (
        <button type="button" onClick={onRetry} className="mk-press97" style={{ height: 52, padding: '0 24px', marginTop: 22, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', ...display, fontSize: 16 }}>
          Try again
        </button>
      ) : (
        <SignInLink className="mk-press97" style={{ height: 52, display: 'inline-flex', alignItems: 'center', padding: '0 24px', marginTop: 22, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', ...display, fontSize: 16, textDecoration: 'none' }}>
          Sign in
        </SignInLink>
      )}
    </div>
  );
}
