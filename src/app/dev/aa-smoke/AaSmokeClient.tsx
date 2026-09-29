'use client';

import { useState } from 'react';
import { encodeFunctionData, type Address } from 'viem';

import { runDisallowedOp, runSponsoredOp, type RunOutcome } from '@/lib/aa-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { useUser } from '@/lib/use-user';
import { USDC_ADDRESS } from '@/lib/usdc';

// ----------------------------------------------------------------------------
// /dev/aa-smoke — Client Component.
//
// Three buttons exercise the AA stack against real Pimlico + Monad testnet:
//
//   1. "Run sponsored op" — happy path. Sponsors `USDC.transfer(safe, 1n)`,
//      signs via Magic, sends, displays the tx hash.
//   2. "Run with tampered signature" — sponsor + sign normally, then mutate
//      the first byte of the ECDSA sig before /api/aa/send. The drift guard
//      (signer recovery) MUST reject with 400 SIG_VALIDATION.
//   3. "Run with disallowed call" — POST a sponsor body whose `call.to` is
//      NOT the USDC contract. /api/aa/sponsor MUST 403 NOT_ALLOWED.
//
// Output: a structured event log showing the request shape, the outcome
// kind, and the relevant fields. Each click clears the previous log and
// starts a fresh run.
//
// This component intentionally does NOT import any server module — it
// only talks to the routes via fetch. The session cookie is sent
// automatically by `credentials: 'same-origin'` in `aa-client.ts`.
// ----------------------------------------------------------------------------

const TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const NON_USDC_ADDRESS: Address =
  '0x000000000000000000000000000000000000dEaD';

type LogEntry = { at: string; level: 'info' | 'ok' | 'warn' | 'err'; msg: string };

export default function AaSmokeClient() {
  const { user, isLoading } = useUser();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  function append(level: LogEntry['level'], msg: string) {
    setLog((prev) => [...prev, { at: new Date().toISOString(), level, msg }]);
  }
  function clear() {
    setLog([]);
  }

  if (isLoading) {
    return <Shell title="loading session…" body={null} />;
  }
  if (!user) {
    return (
      <Shell
        title="not signed in"
        body={
          <p>
            Visit <a href="/signup">/signup</a> first to sign in with email.
            The dev surface uses your active session cookie to call the AA routes.
          </p>
        }
      />
    );
  }
  // Magic-only — wallet sessions have no Safe and can't drive the
  // ERC-4337 sponsor / send routes (plan step 18 narrowing). Render a
  // wallet-shape "use a Magic account" notice instead of a notFound,
  // because this page is already MAKO_STAGE-gated by the Server
  // Component wrapper.
  if (user.authType !== 'magic') {
    return (
      <Shell
        title="wallet sessions cannot use this dev surface"
        body={
          <p>
            The AA dev surface drives ERC-4337 user-ops via your derived
            Safe. Wallet-session users have no Safe — sign out and sign
            in with email at <a href="/signup">/signup</a>.
          </p>
        }
      />
    );
  }

  const safeAddress = user.safeAddress as Address;
  const magicEoa = user.magicEoa as Address;

  async function runHappy() {
    if (busy) return;
    setBusy(true);
    clear();
    try {
      append('info', `safe=${safeAddress}  magicEoa=${magicEoa}`);
      append('info', 'POST /api/aa/sponsor (USDC.transfer(safe, 1n))…');
      const data = encodeFunctionData({
        abi: TRANSFER_ABI,
        functionName: 'transfer',
        args: [safeAddress, 1n],
      });
      const outcome = await runSponsoredOp({
        chainId: MONAD_TESTNET_ID,
        magicEoa,
        call: { to: USDC_ADDRESS, value: '0x0', data },
        mode: 'happy',
      });
      logOutcome(outcome, append);
    } catch (e) {
      append('err', `unexpected throw: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runTampered() {
    if (busy) return;
    setBusy(true);
    clear();
    try {
      append(
        'info',
        'tampered mode: sponsor + sign normally, then flip first byte of ECDSA sig before /api/aa/send.',
      );
      const data = encodeFunctionData({
        abi: TRANSFER_ABI,
        functionName: 'transfer',
        args: [safeAddress, 1n],
      });
      const outcome = await runSponsoredOp({
        chainId: MONAD_TESTNET_ID,
        magicEoa,
        call: { to: USDC_ADDRESS, value: '0x0', data },
        mode: 'tampered',
      });
      logOutcome(outcome, append);
      if (outcome.kind === 'send_failed' && outcome.error === 'SIG_VALIDATION') {
        append('ok', '✓ drift guard fired — tampered sig rejected');
      } else if (outcome.kind === 'sent' || outcome.kind === 'submitted') {
        append('err', '✗ tampered sig was NOT rejected — drift guard regression');
      }
    } catch (e) {
      append('err', `unexpected throw: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runDisallowed() {
    if (busy) return;
    setBusy(true);
    clear();
    try {
      append('info', `disallowed mode: target=${NON_USDC_ADDRESS}, expect 403 NOT_ALLOWED`);
      const outcome = await runDisallowedOp({
        chainId: MONAD_TESTNET_ID,
        to: NON_USDC_ADDRESS,
      });
      logOutcome(outcome, append);
      if (outcome.kind === 'sponsor_failed' && outcome.error === 'NOT_ALLOWED') {
        append('ok', `✓ allowlist fired — reason=${outcome.reason ?? 'unknown'}`);
      } else {
        append('err', '✗ allowlist did NOT reject');
      }
    } catch (e) {
      append('err', `unexpected throw: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title="aa-smoke (dev only)"
      body={
        <>
          <section style={{ marginBottom: '1rem' }}>
            <p style={{ margin: 0 }}>
              <strong>email:</strong> {user.email}
            </p>
            <p style={{ margin: 0 }}>
              <strong>magic eoa:</strong> <code>{magicEoa}</code>
            </p>
            <p style={{ margin: 0 }}>
              <strong>safe:</strong> <code>{safeAddress}</code>
            </p>
            <p style={{ margin: 0, color: '#666' }}>
              Fund the Safe with ≥1 USDC on Monad testnet via{' '}
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                Circle&apos;s faucet
              </a>{' '}
              before clicking Happy Path (otherwise the on-chain transfer
              will revert and you&apos;ll see status=reverted).
            </p>
          </section>

          <section
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginBottom: '1rem',
            }}
          >
            <button
              type="button"
              onClick={runHappy}
              disabled={busy}
              style={btnStyle}
            >
              Run sponsored op (happy)
            </button>
            <button
              type="button"
              onClick={runTampered}
              disabled={busy}
              style={btnStyle}
            >
              Run with tampered signature
            </button>
            <button
              type="button"
              onClick={runDisallowed}
              disabled={busy}
              style={btnStyle}
            >
              Run with disallowed call
            </button>
          </section>

          <section
            style={{
              border: '1px solid #ddd',
              borderRadius: '4px',
              padding: '0.75rem',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              whiteSpace: 'pre-wrap',
              minHeight: '120px',
              background: '#0b0b0b',
              color: '#e6e6e6',
            }}
          >
            {log.length === 0 ? (
              <span style={{ color: '#666' }}>no events — click a button</span>
            ) : (
              log.map((e, i) => (
                <div
                  key={i}
                  style={{
                    color:
                      e.level === 'ok'
                        ? '#7fdf7f'
                        : e.level === 'warn'
                          ? '#ffd07a'
                          : e.level === 'err'
                            ? '#ff7a7a'
                            : '#e6e6e6',
                  }}
                >
                  [{e.at.slice(11, 19)}] {e.msg}
                </div>
              ))
            )}
          </section>
        </>
      }
    />
  );
}

function logOutcome(outcome: RunOutcome, append: (l: LogEntry['level'], m: string) => void) {
  switch (outcome.kind) {
    case 'sent':
      append(
        'ok',
        `SENT — tx=${outcome.txHash}  userOpHash=${outcome.userOpHash}  rowId=${outcome.pendingUserOpId}${outcome.recovered ? '  (recovered)' : ''}`,
      );
      break;
    case 'reverted':
      append(
        'warn',
        `REVERTED — tx=${outcome.txHash}  userOpHash=${outcome.userOpHash}  reason=${outcome.failureReason}`,
      );
      append(
        'info',
        'On-chain revert is normal if the Safe has no USDC balance. Fund via Circle faucet to see SENT.',
      );
      break;
    case 'submitted':
      append(
        'info',
        `SUBMITTED — bundler accepted but receipt not yet confirmed.  userOpHash=${outcome.userOpHash}`,
      );
      break;
    case 'failed_pre_submit':
      append('warn', `FAILED_PRE_SUBMIT — bundler rejected.  reason=${outcome.failureReason}`);
      break;
    case 'expired':
      append('warn', `EXPIRED — pending row TTL elapsed before send.`);
      break;
    case 'in_progress':
      append(
        'info',
        `IN PROGRESS — row is sending; retry in ${outcome.retryAfterSeconds}s.`,
      );
      break;
    case 'manual_review':
      append('warn', 'MANUAL REVIEW — row is ambiguous. See operator runbook.');
      break;
    case 'sponsor_failed':
      append(
        'err',
        `sponsor failed — status=${outcome.status} error=${outcome.error}${outcome.reason ? ` reason=${outcome.reason}` : ''}${outcome.detail ? ` detail=${outcome.detail}` : ''}`,
      );
      break;
    case 'send_failed':
      append(
        'err',
        `send failed — status=${outcome.status} error=${outcome.error}${outcome.detail ? ` detail=${outcome.detail}` : ''}`,
      );
      break;
  }
}

function Shell({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  return (
    <main
      style={{
        maxWidth: '720px',
        margin: '2rem auto',
        padding: '1.5rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>{title}</h1>
        <p style={{ margin: '0.25rem 0 0', color: '#888' }}>
          Phase 1B sub-phase D — exercises /api/aa/sponsor + /api/aa/send
          against Pimlico + Monad testnet. Dev only.
        </p>
      </header>
      {body}
    </main>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  fontSize: '0.9rem',
  border: '2px solid #000',
  background: '#fff',
  cursor: 'pointer',
  fontWeight: 600,
};
