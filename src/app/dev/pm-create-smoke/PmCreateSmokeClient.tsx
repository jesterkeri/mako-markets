'use client';

import { useState } from 'react';
import { toHex, type Address, type Hex } from 'viem';

import {
  runCreatePrivateMarket,
  type RunOutcome,
} from '@/lib/aa-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { useUser } from '@/lib/use-user';
import type { PmCreateParamsTuple } from '@/lib/private-markets/abi-fragments';

// ----------------------------------------------------------------------------
// /dev/pm-create-smoke — Client Component.
//
// Three buttons exercise the full PM create-market flow against real
// Pimlico + Monad testnet + the deployed MakoPrivateMarketsV1 contract:
//
//   1. "Friendly"   — binary YES/NO market, 2 option labels, no
//                     winnersCount, no fixedStake.
//   2. "Open Vote"  — multi-option vote, non-zero fixedStake.
//   3. "Prize Pool" — multi-option pool, participant wallets, non-zero
//                     winnersCount.
//
// Each button:
//   • Generates a fresh clientNonce.
//   • POSTs /api/pm/markets/draft to reserve slug + insert pending row.
//   • Encodes createMarket callData with PM_CREATE_MARKET_ABI.
//   • POSTs /api/aa/sponsor (kind='pm_create_market').
//   • Signs via Magic.
//   • POSTs /api/aa/send.
//   • Renders a structured event log with the resulting outcome.
//
// Mandatory follow-up after a successful click: query the DB and
// confirm the row landed:
//   SELECT slug, market_id, create_status, confirmed_at
//     FROM pm_markets
//    ORDER BY pending_at DESC LIMIT 1;
// Expected: create_status='confirmed', market_id non-null,
// confirmed_at non-null.
// ----------------------------------------------------------------------------

type LogEntry = { at: string; level: 'info' | 'ok' | 'warn' | 'err'; msg: string };

export default function PmCreateSmokeClient() {
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
            Visit <a href="/signup">/signup</a> first to authenticate via Magic.
            The dev surface uses your active session cookie to call the AA
            routes + the PM draft route.
          </p>
        }
      />
    );
  }
  if (user.authType !== 'magic') {
    return (
      <Shell
        title="wallet sessions cannot use this dev surface"
        body={
          <p>
            The PM create flow drives ERC-4337 user-ops via your derived Safe.
            Wallet-session users have no Safe — sign out and sign in via Magic
            at <a href="/signup">/signup</a>.
          </p>
        }
      />
    );
  }

  const safeAddress = user.safeAddress as Address;
  const magicEoa = user.magicEoa as Address;

  async function runShape(
    label: string,
    createParams: Omit<PmCreateParamsTuple, 'clientNonce'>,
  ) {
    if (busy) return;
    setBusy(true);
    clear();
    try {
      append('info', `safe=${safeAddress}  magicEoa=${magicEoa}`);
      append('info', `creating ${label} market via runCreatePrivateMarket…`);
      const outcome = await runCreatePrivateMarket({
        chainId: MONAD_TESTNET_ID,
        magicEoa,
        createParams,
      });
      logOutcome(outcome, append);
      if (outcome.kind === 'sent') {
        append(
          'info',
          'Verify the DB row with: SELECT slug, market_id, create_status FROM pm_markets ORDER BY pending_at DESC LIMIT 1;',
        );
      }
    } catch (e) {
      append('err', `unexpected throw: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // ── Per-shape fixtures ────────────────────────────────────────────────
  // stakingOpensAt = now + 60s (sponsor-time clock check passes), closeAt
  // = stakingOpensAt + 1h. Bumped to + 5min for Friendly to leave room
  // for the user to inspect the row before staking opens. UI-time math
  // — the sponsor route re-reads chain time and re-validates.

  async function runFriendly() {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await runShape('Friendly', {
      shape: 0,
      stakingOpensAt: now + 60n,
      closeAt: now + 3600n,
      title: toHex('PM smoke — will the next block hash start with 0?'),
      description: toHex(''),
      streamUrl: toHex(''),
      optionLabels: [toHex('NO'), toHex('YES')],
      participantWallets: [],
      allowlist: [],
      viewMode: 1, // Public
      participationMode: 0, // Open
      perStakeMin: 0n,
      perStakeMax: 0n,
      perWalletCumulativeMax: 0n,
      fixedStake: 0n,
      winnersCount: 0,
    });
  }

  async function runOpenVote() {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await runShape('Open Vote', {
      shape: 1,
      stakingOpensAt: now + 60n,
      closeAt: now + 3600n,
      title: toHex('PM smoke — open vote'),
      description: toHex('Pick a winner'),
      streamUrl: toHex(''),
      optionLabels: [toHex('A'), toHex('B'), toHex('C')],
      participantWallets: [],
      allowlist: [],
      viewMode: 1,
      participationMode: 0,
      perStakeMin: 0n,
      perStakeMax: 0n,
      perWalletCumulativeMax: 0n,
      fixedStake: 10_000n, // = PM_MIN_STAKE (0.01 USDC)
      winnersCount: 1,
    });
  }

  async function runPrizePool() {
    const now = BigInt(Math.floor(Date.now() / 1000));
    // Three throwaway participant addresses — never the user's safe,
    // never the treasury. Smoke-test values only.
    const PARTICIPANT_A = '0x0000000000000000000000000000000000000aaa' as Address;
    const PARTICIPANT_B = '0x0000000000000000000000000000000000000bbb' as Address;
    const PARTICIPANT_C = '0x0000000000000000000000000000000000000ccc' as Address;
    await runShape('Prize Pool', {
      shape: 2,
      stakingOpensAt: now + 60n,
      closeAt: now + 3600n,
      title: toHex('PM smoke — prize pool'),
      description: toHex('Pick a winner'),
      streamUrl: toHex(''),
      optionLabels: [toHex('Alice'), toHex('Bob'), toHex('Carol')],
      participantWallets: [PARTICIPANT_A, PARTICIPANT_B, PARTICIPANT_C],
      allowlist: [],
      viewMode: 1,
      participationMode: 0,
      perStakeMin: 0n,
      perStakeMax: 0n,
      perWalletCumulativeMax: 0n,
      fixedStake: 0n,
      winnersCount: 1,
    });
  }

  return (
    <Shell
      title="pm-create-smoke (dev only)"
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
              Phase 2C-1 PM createMarket smoke. No USDC needed — the
              createMarket call doesn&apos;t transfer funds. After a
              successful click, verify the DB row:{' '}
              <code>
                SELECT slug, market_id, create_status FROM pm_markets ORDER
                BY pending_at DESC LIMIT 1;
              </code>
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
              onClick={runFriendly}
              disabled={busy}
              style={btnStyle}
            >
              Friendly
            </button>
            <button
              type="button"
              onClick={runOpenVote}
              disabled={busy}
              style={btnStyle}
            >
              Open Vote
            </button>
            <button
              type="button"
              onClick={runPrizePool}
              disabled={busy}
              style={btnStyle}
            >
              Prize Pool
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

function logOutcome(
  outcome: RunOutcome,
  append: (l: LogEntry['level'], m: string) => void,
) {
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
      break;
    case 'submitted':
      append(
        'info',
        `SUBMITTED — userOpHash=${outcome.userOpHash}  rowId=${outcome.pendingUserOpId} (bundler accepted; receipt pending)`,
      );
      break;
    case 'failed_pre_submit':
      append(
        'err',
        `FAILED PRE-SUBMIT — rowId=${outcome.pendingUserOpId}  reason=${outcome.failureReason}`,
      );
      break;
    case 'expired':
      append(
        'warn',
        `EXPIRED — rowId=${outcome.pendingUserOpId} (TTL elapsed; user took too long to sign)`,
      );
      break;
    case 'in_progress':
      append(
        'info',
        `IN PROGRESS — rowId=${outcome.pendingUserOpId} retry in ${outcome.retryAfterSeconds}s (Phase 1I polling)`,
      );
      break;
    case 'manual_review':
      append(
        'err',
        `MANUAL REVIEW — rowId=${outcome.pendingUserOpId} (cron flagged; operator action required)`,
      );
      break;
    case 'sponsor_failed':
      append(
        'err',
        `SPONSOR FAILED — step=${outcome.step ?? 'sponsor'}  status=${outcome.status}  error=${outcome.error}${outcome.reason ? `  reason=${outcome.reason}` : ''}${outcome.detail ? `  detail=${outcome.detail}` : ''}`,
      );
      break;
    case 'send_failed':
      append(
        'err',
        `SEND FAILED — status=${outcome.status}  error=${outcome.error}${outcome.detail ? `  detail=${outcome.detail}` : ''}`,
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
        padding: '1rem',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ fontSize: '1.25rem', margin: '0 0 1rem' }}>{title}</h1>
      {body}
    </main>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '0.5rem 0.875rem',
  border: '1px solid #333',
  borderRadius: '4px',
  background: '#fff',
  cursor: 'pointer',
  fontWeight: 600,
};
