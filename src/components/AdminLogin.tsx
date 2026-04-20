'use client';

import { useState } from 'react';
import { useAccount, useChainId, useSignMessage } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { SiweMessage } from 'siwe';
import { ADMIN_ADDRESS } from '@/lib/admin';

/**
 * SIWE login panel shown when the connected wallet matches ADMIN_ADDRESS
 * but the server hasn't yet issued a session cookie (or the cookie expired).
 *
 * Flow: fetch a nonce → build a SIWE message → ask the wallet to sign →
 * POST { message, signature } to /api/auth/verify → server sets an
 * HMAC-signed session cookie → invalidate the analytics query so the
 * admin page re-fetches and renders.
 *
 * This panel is only ever rendered by /admin/* pages — nothing about the
 * public UX changes.
 */
export function AdminLogin({ onDone }: { onDone?: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signIn() {
    if (!address) return;
    setBusy(true);
    setErr(null);
    try {
      const nonceRes = await fetch('/api/auth/nonce', { cache: 'no-store' });
      if (!nonceRes.ok) throw new Error('NONCE_FAILED');
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      const siwe = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to Mako Market admin dashboard.',
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce,
        issuedAt: new Date().toISOString(),
      });
      const message = siwe.prepareMessage();
      const signature = await signMessageAsync({ message });

      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      if (!verifyRes.ok) {
        // Capture the raw body for diagnosis — if /verify 500s, Next returns
        // an HTML error page which isn't parseable JSON, and we'd otherwise
        // throw "UNKNOWN" with no context. Log the body so the browser
        // console shows what actually came back.
        const raw = await verifyRes.text();
        console.error('[admin-login] verify failed', verifyRes.status, raw);
        let parsedError: string | undefined;
        try {
          parsedError = (JSON.parse(raw) as { error?: string }).error;
        } catch {}
        throw new Error(parsedError ?? `HTTP_${verifyRes.status}`);
      }
      // Invalidate BOTH admin queries. The analytics query's 401 drives
      // the login panel on /admin, /admin/users, /admin/markets, /admin/activity.
      // The session query drives the login panel on /admin/resolve (which
      // doesn't fetch analytics). Without the second invalidation, /admin/resolve
      // would stay on the login panel until a manual reload — caught by codex.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-analytics'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-session'] }),
      ]);
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message.toUpperCase() : 'SIGN_FAILED');
    } finally {
      setBusy(false);
    }
  }

  const wrongWallet =
    address && address.toLowerCase() !== ADMIN_ADDRESS.toLowerCase();

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
      <h1 className="text-3xl font-black uppercase tracking-tight">ADMIN SIGN-IN</h1>
      <p className="text-muted text-xs font-bold uppercase tracking-widest max-w-sm">
        SIGN A ONE-OFF MESSAGE WITH THE ADMIN WALLET TO UNLOCK THE DASHBOARD. NO GAS. NO ON-CHAIN TX.
      </p>
      <p className="text-[10px] font-mono text-subtle break-all max-w-xs">
        ADMIN: {ADMIN_ADDRESS}
      </p>

      {wrongWallet ? (
        <p className="text-warning text-[11px] font-black uppercase tracking-widest max-w-sm">
          CONNECTED WALLET IS NOT THE ADMIN · SWITCH WALLETS
        </p>
      ) : null}

      <button
        type="button"
        onClick={signIn}
        disabled={busy || !address || !!wrongWallet}
        className="mt-4 bg-black text-background font-black text-[11px] uppercase tracking-widest px-6 py-3 hover:bg-transparent hover:text-foreground border border-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? 'WAITING FOR SIGNATURE…' : '[ SIGN IN AS ADMIN ]'}
      </button>

      {err ? (
        <p className="text-warning text-[10px] font-black uppercase tracking-widest">
          {err}
        </p>
      ) : null}
    </main>
  );
}
