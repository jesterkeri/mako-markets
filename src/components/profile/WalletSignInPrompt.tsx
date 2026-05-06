'use client';

import { useState } from 'react';
import { useSignMessage } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';

import { signInWithWallet } from '@/lib/wallet-auth-client';
import { USER_QUERY_KEY } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// WalletSignInPrompt
//
// Rendered inside IdentityBlock when there's a wagmi-connected wallet
// but no `mako_user_session` cookie. Asks the user to sign a SIWE
// message — no transaction, no gas — to bind the wallet to a Mako
// Market profile (display name + avatar).
//
// On success, the route returns a typed WalletAuthedUser; we write it
// straight into the ['user'] cache (avoiding a network round-trip back
// to /api/user/me) and then invalidate so any other observers refetch
// from the canonical source.
// ----------------------------------------------------------------------------

export function WalletSignInPrompt({ address }: { address: `0x${string}` }) {
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <div className="flex flex-col gap-3">
      <h2 className="mako-label text-muted">SIGNED IN AS</h2>
      <p className="mako-title text-[clamp(1.25rem,2vw,1.5rem)] break-all leading-tight">
        {formatAddress(address)}
      </p>
      <div className="bg-paper border-2 border-ink p-3 rounded-xl flex flex-col gap-2 mt-2">
        <h3 className="mako-display text-base">ENABLE PROFILE</h3>
        <p className="mako-body text-sm leading-snug">
          Sign a message with your wallet to set a display name and
          avatar. No transaction, no gas — just a wallet signature.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            const r = await signInWithWallet({ address, signMessageAsync });
            setBusy(false);
            if (r.ok) {
              // r.user is a typed WalletAuthedUser — exactly the shape
              // ['user'] expects. signInWithWallet stripped the route's
              // `ok` flag so this write does NOT leak `ok: true` into
              // the cache (codex round-2 MAJOR fix).
              queryClient.setQueryData(USER_QUERY_KEY, r.user);
              await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
            } else {
              setError(r.error);
            }
          }}
          className="mako-button mako-label text-[10px] self-start mt-1"
        >
          {busy ? 'AWAITING SIGNATURE…' : 'SIGN IN WITH WALLET'}
        </button>
        {error && (
          <p role="alert" className="mako-body text-xs text-mako-red mt-1">
            {humanizeError(error)}
          </p>
        )}
      </div>
    </div>
  );
}

function formatAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function humanizeError(e: string): string {
  switch (e) {
    case 'user_rejected':
      return 'You rejected the signature in your wallet.';
    case 'wrong_chain':
      return 'Switch your wallet to Monad testnet and try again.';
    case 'cross_origin':
      return 'Origin mismatch. Refresh and try again.';
    case 'domain_mismatch':
    case 'uri_mismatch':
    case 'statement_mismatch':
    case 'bad_version':
      return 'Sign-in message rejected. Refresh and try again.';
    case 'bad_signature':
      return 'Signature did not match the connected wallet.';
    case 'nonce_failed':
    case 'nonce_mismatch':
    case 'no_nonce':
    case 'bad_nonce':
      return 'Sign-in expired. Try again.';
    case 'tx_failed':
    case 'verify_failed':
    case 'sign_failed':
    case 'bad_body':
    case 'bad_message':
      return 'Sign-in failed. Refresh and try again.';
    default:
      return 'Sign-in failed. Refresh and try again.';
  }
}
