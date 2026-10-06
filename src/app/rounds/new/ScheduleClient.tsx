'use client';

import Link from 'next/link';
import { useState } from 'react';

import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';
import { ListStateDesktop } from '@/components/ListState';
import { SignInLink } from '@/components/signin/SignInLink';
import { BOUNDARY_STEP_S, DURATION_S, ENTRY_LEAD_S, MIN_LEAD_S, scheduleBlocker, V1_ASSET } from '@/lib/rounds-model';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { useRoundTx } from '@/lib/use-round-tx';
import { roundsContract, useIsCreator } from '@/lib/use-rounds';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

const pad = (n: number) => String(n).padStart(2, '0');
/// A unix time as the value of a `datetime-local` input, in the browser's time zone.
function toLocalInput(unixS: number): string {
  const d = new Date(unixS * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): number | null {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
const when = (unixS: number) => new Date(unixS * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function walletOf(user: AuthedUser): { kind: 'mako' | 'external'; address: string } {
  return user.authType === 'magic' ? { kind: 'mako', address: user.safeAddress } : { kind: 'external', address: user.walletAddress };
}

export function ScheduleClient() {
  const now = useLiveNowSec();
  const { user } = useUser();
  const isCreator = useIsCreator(user ? accountAddress(user) : null);
  const tx = useRoundTx();
  /// Until the creator picks a time: the first whole minute at least 15 minutes out.
  const firstDefault = now === null ? null : Math.ceil((now + MIN_LEAD_S + 300) / BOUNDARY_STEP_S) * BOUNDARY_STEP_S;
  const [text, setText] = useState<string | null>(null);
  const value = text ?? (firstDefault === null ? '' : toLocalInput(firstDefault));
  const start = fromLocalInput(value);
  const why = start === null || now === null ? 'Pick a start time.' : scheduleBlocker(start, now);
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);

  const frame = (child: React.ReactNode) => (
    <div className="mk-desk-frame" style={{ padding: '14px 4px 32px', maxWidth: 640 }}>
      <Link href="/rounds" style={{ ...mono, fontSize: 12, color: 'var(--dim)', textDecoration: 'none' }}>
        ← ROUNDS
      </Link>
      <h1 style={{ margin: '12px 0 8px', ...display, fontSize: 44, lineHeight: 1, letterSpacing: '-0.035em' }}>Schedule a round</h1>
      {child}
    </div>
  );

  if (!roundsContract) return frame(<ListStateDesktop kind="rounds" state="not_open" />);
  if (!user) {
    return frame(
      <SignInLink className="mk-press96" style={{ height: 52, display: 'inline-flex', alignItems: 'center', padding: '0 22px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 16, textDecoration: 'none' }}>
        Sign in to schedule
      </SignInLink>,
    );
  }
  if (isCreator === null) return frame(<div style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>CHECKING…</div>);
  if (!isCreator) {
    return frame(
      <div style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--dim)' }}>
        Rounds are hosted by Mako Market&apos;s invited creators, so this account can&apos;t schedule one. Every round is open to everyone to predict on.
      </div>,
    );
  }

  const openSchedule = () => {
    if (why || start === null || tx.tx) return;
    setSpec({
      glyph: '+',
      glyphColor: 'var(--mako-teal)',
      title: `Schedule · ${when(start)}`,
      confirmLabel: 'Confirm',
      pendingTitle: 'Scheduling the round',
      rows: [
        { label: 'Asset', value: V1_ASSET.pair },
        { label: 'Predictions', value: `open now, close ${when(start - ENTRY_LEAD_S)}` },
        { label: 'Runs', value: `${when(start)} to ${when(start + DURATION_S)}` },
      ],
      note: 'Anyone can predict as soon as it is scheduled. A creator can have one unfinished round at a time.',
      doneTitle: 'Round scheduled',
      doneBody: `It starts ${when(start)}. It is on the Rounds tab now.`,
      doneSecondary: { label: 'Go to Rounds', href: '/rounds' },
    });
    tx.open({ kind: 'schedule', startTime: BigInt(start) });
  };

  return (
    <>
      {frame(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--dim)' }}>
            A {V1_ASSET.pair} round of 15 minutes. It opens for predictions the moment it is scheduled and closes one minute before the start. Pick a whole minute, 10 minutes to 7 days from now.
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>START (YOUR LOCAL TIME)</span>
            <input
              type="datetime-local"
              step={60}
              value={value}
              onChange={(e) => setText(e.target.value)}
              style={{ height: 52, padding: '0 14px', borderRadius: 12, border: 0, background: 'var(--raise)', color: 'var(--mako-canvas-fg)', ...mono, fontSize: 16 }}
            />
          </label>
          {why && <div style={{ fontSize: 13, padding: '10px 12px', borderRadius: 10, boxShadow: 'inset 0 0 0 1px var(--line)' }}>{why}</div>}
          <button
            onClick={openSchedule}
            disabled={why !== null}
            className="mk-press96"
            style={{ height: 56, borderRadius: 9999, background: why ? 'var(--raise2)' : 'var(--mako-signal)', color: why ? 'var(--dim)' : '#000', boxShadow: why ? 'none' : 'var(--edge)', ...display, fontSize: 17, cursor: why ? 'not-allowed' : 'pointer' }}
          >
            {start !== null && !why ? `Schedule for ${when(start)}` : "Can't schedule this time"}
          </button>
        </div>,
      )}
      {tx.tx && spec && <ConfirmSheet spec={spec} phase={tx.phase} wallet={walletOf(user)} onConfirm={tx.confirm} onCancel={tx.close} onRetry={tx.retry} onClose={tx.close} />}
    </>
  );
}
