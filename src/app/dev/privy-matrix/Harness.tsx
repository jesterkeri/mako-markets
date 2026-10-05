'use client';

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useCreateWallet, useLoginWithEmail, useMfa, useMfaEnrollment, usePrivy, useWallets } from '@privy-io/react-auth';

// Buttons for each step the Privy test matrix needs, calling Privy directly. Nothing here prints an access token,
// a private key or a recovery phrase: export opens Privy's own screen, and signatures are shown shortened.

const box: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 };
const btn: React.CSSProperties = { height: 36, padding: '0 14px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', fontWeight: 700, alignSelf: 'flex-start' };
const field: React.CSSProperties = { height: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--raise)', color: 'var(--mako-canvas-fg)' };

/// Waits on the browser's monotonic clock, as the plan's [G3]/[H2] wallet creation does.
async function waitMonotonic(ms: number) {
  const start = performance.now();
  while (performance.now() - start < ms) await new Promise((r) => setTimeout(r, 50));
}

const hint: React.CSSProperties = { margin: 0, fontSize: 13, color: 'var(--dim)', lineHeight: 1.5 };

/// What to do about the errors Privy gives during the matrix, in plain words.
function explain(message: string): string {
  if (/MFA is not enabled/i.test(message)) {
    return '2FA is switched off for the development Privy app. In the Privy dashboard, turn on MFA for transactions with the authenticator app (TOTP), then press Start again.';
  }
  if (/Invalid email and code/i.test(message)) return 'That email code was wrong or has expired. Press Send code for a new one.';
  if (/already has an embedded wallet/i.test(message)) return 'This user already has a wallet; the test only needs one.';
  return message;
}

const short = (s: string) => (s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s);

export function PrivyMatrixHarness() {
  const { ready, authenticated, user, logout, exportWallet } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { initEnrollmentWithTotp, submitEnrollmentWithTotp } = useMfaEnrollment();
  const { clear } = useMfa();
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState<{ authUrl: string; secret: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const note = (line: string) => setLog((l) => [`${new Date().toISOString().slice(11, 19)} ${line}`, ...l].slice(0, 30));
  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    try {
      const r = await fn();
      note(`${label}: ok${typeof r === 'string' ? ` (${short(r)})` : ''}`);
    } catch (e) {
      note(`${label}: FAILED. ${explain(e instanceof Error ? e.message : String(e))}`);
    }
  };

  const embedded = (user?.linkedAccounts ?? []).filter(
    (a): a is Extract<typeof a, { type: 'wallet' }> => a.type === 'wallet' && 'walletClientType' in a && a.walletClientType === 'privy',
  );
  const ethWallet = wallets.find((w) => w.walletClientType === 'privy');

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px 80px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0 }}>Privy test matrix (dev only)</h1>
      <p style={{ margin: 0, color: 'var(--dim)' }}>
        For mako-design/PRIVY_MATRIX_RUNBOOK.md. Uses the development Privy app. Creates no Mako Market session.
      </p>

      <section style={box}>
        <strong>State</strong>
        <div>Privy ready: {String(ready)} · signed in: {String(authenticated)}</div>
        <div>User: {user ? short(user.id) : 'none'} · email: {user?.email?.address ?? 'none'}</div>
        <div>Second factors: {user?.mfaMethods?.length ? user.mfaMethods.join(', ') : 'none'}</div>
        <div>
          Embedded wallets: {embedded.length === 0 ? 'none' : embedded.map((w) => `${w.chainType} ${short(w.address)}${'id' in w && w.id ? ` id ${w.id}` : ''}`).join(' | ')}
        </div>
      </section>

      <section style={box}>
        <strong>1. Email sign-in (Privy only)</strong>
        <p style={hint}>Type the test email, press Send code, then type the code from that inbox and press Log in with code. State above should then say signed in: true.</p>
        <input style={field} value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder="test email" aria-label="Test email" />
        <button style={btn} onClick={run('send code', () => sendCode({ email }))}>Send code</button>
        <input style={field} value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="code from the email" aria-label="Email code" />
        <button style={btn} onClick={run('log in with code', () => loginWithCode({ code }))}>Log in with code</button>
        <button style={btn} onClick={run('log out', () => logout())}>Log out</button>
      </section>

      <section style={box}>
        <strong>2. Set up the authenticator (TOTP)</strong>
        <p style={hint}>
          Sign in first. Press Start: a QR code appears. Scan it with your authenticator app (or type the code shown under it). The app then shows a
          6-digit code: type it here and press Finish. State should then list totp under Second factors. If the log says 2FA is switched off, change the
          development Privy app&apos;s dashboard first.
        </p>
        <button
          disabled={!authenticated}
          style={btn}
          onClick={run('start TOTP enrollment', async () => {
            const r = await initEnrollmentWithTotp();
            setTotp(r);
          })}
        >
          Start
        </button>
        {totp && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ padding: 10, background: '#fff', borderRadius: 8, lineHeight: 0 }}>
              <QRCodeSVG value={totp.authUrl} size={150} bgColor="#ffffff" fgColor="#000000" />
            </div>
            <span style={{ fontSize: 12, color: 'var(--dim)', wordBreak: 'break-all' }}>Test account only. Manual entry: {totp.secret}</span>
          </div>
        )}
        <input style={field} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.trim())} placeholder="6-digit code" aria-label="Authenticator code" />
        <button style={btn} onClick={run('finish TOTP enrollment', () => submitEnrollmentWithTotp({ mfaCode }))}>Finish</button>
      </section>

      <section style={box}>
        <strong>3. Wallet</strong>
        <p style={hint}>Create the wallet only when the runbook step says so (most tests set up 2FA first and use the 1.1 s button).</p>
        <button style={btn} onClick={run('create wallet now', () => createWallet().then((w) => w.address))}>Create wallet now</button>
        <button
          style={btn}
          onClick={run('create wallet after 1.1 s', async () => {
            await waitMonotonic(1100);
            return (await createWallet()).address;
          })}
        >
          Create wallet after 1.1 s
        </button>
      </section>

      <section style={box}>
        <strong>4. Use the wallet</strong>
        <button style={btn} onClick={run('clear MFA reuse', () => clear())}>Forget recent 2FA (useMfa().clear)</button>
        <button
          style={btn}
          disabled={!ethWallet}
          onClick={run('sign a test message', async () => {
            const provider = await ethWallet!.getEthereumProvider();
            return provider.request({ method: 'personal_sign', params: ['Mako Market matrix test', ethWallet!.address] }) as Promise<string>;
          })}
        >
          Sign a test message
        </button>
        <button style={btn} disabled={!ethWallet} onClick={run('export (Privy screen)', () => exportWallet({ address: ethWallet!.address }))}>
          Export key (opens Privy&apos;s screen)
        </button>
      </section>

      <section style={box}>
        <strong>Log</strong>
        <div style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{log.join('\n') || 'Nothing yet.'}</div>
      </section>
    </main>
  );
}
