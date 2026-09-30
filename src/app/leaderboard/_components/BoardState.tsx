'use client';

import Link from 'next/link';

import { Mascot } from '@/components/Mascot';
import { BOARD_COPY, boardStateCopy, type BoardAction } from '@/lib/leaderboard/board-copy';
import type { BoardPeriod } from '@/lib/leaderboard/board-view';

// Loading, empty and error for the leaderboard, in the shared list-state look (16a, src/components/ListState.tsx).
// That component's copy is keyed to rounds, pools and Me, so the board carries its own copy (board-copy.ts) and its
// own skeletons, shaped like the podium, the bars and the rows.

type Props = {
  state: 'loading' | 'empty' | 'error';
  period: BoardPeriod;
  syncing: boolean;
  onRetry: () => void;
  onPeriod: (p: BoardPeriod) => void;
};

const bar = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

export const DESK_COLS = '70px minmax(0,1fr) 150px 90px 130px 20px';

function Action({ action, onRetry, onPeriod, style, className }: { action: BoardAction; onRetry: () => void; onPeriod: (p: BoardPeriod) => void; style: React.CSSProperties; className: string }) {
  if ('retry' in action) {
    return (
      <button onClick={onRetry} className={className} style={style}>
        {action.label}
      </button>
    );
  }
  if ('period' in action) {
    return (
      <button onClick={() => onPeriod(action.period)} className={className} style={style}>
        {action.label}
      </button>
    );
  }
  return (
    <Link href={action.href} className={className} style={{ ...style, textDecoration: 'none' }}>
      {action.label}
    </Link>
  );
}

export function BoardStateDesktop({ state, period, syncing, onRetry, onPeriod }: Props) {
  if (state === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading">
        <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', padding: '0 4px 8px' }}>{BOARD_COPY.loading}</div>
        <div style={{ padding: '0 4px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.15fr 1fr', gap: 14, alignItems: 'end', marginTop: 6 }}>
            {[200, 240, 180].map((h) => (
              <div key={h} style={{ height: h, borderRadius: 14, background: 'var(--raise)', padding: 18, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 52, height: 52, borderRadius: 9999, background: bar }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ width: 36, height: 16, borderRadius: 999, background: bar }} />
                    <div style={{ width: 110, height: 16, borderRadius: 8, background: bar }} />
                  </div>
                </div>
                <div style={{ marginTop: 'auto', width: 140, height: 30, borderRadius: 8, background: bar }} />
              </div>
            ))}
          </div>
        </div>
        <div style={{ height: 22 }} />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: DESK_COLS, gap: 18, alignItems: 'center', padding: '16px 20px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
            <div style={{ width: 36, height: 16, borderRadius: 8, background: bar }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9999, background: bar }} />
              <div style={{ width: '40%', height: 14, borderRadius: 8, background: bar }} />
            </div>
            <div style={{ justifySelf: 'end', width: 90, height: 14, borderRadius: 8, background: bar }} />
            <div style={{ justifySelf: 'end', width: 30, height: 14, borderRadius: 8, background: bar }} />
            <div style={{ justifySelf: 'end', width: 80, height: 14, borderRadius: 8, background: bar }} />
            <span />
          </div>
        ))}
      </div>
    );
  }
  const c = boardStateCopy(state, { period, syncing });
  const button: React.CSSProperties = { height: 52, display: 'inline-flex', alignItems: 'center', padding: '0 24px', borderRadius: 9999, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 16 };
  return (
    <div role={state === 'error' ? 'alert' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '64px 4px 72px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <Mascot pose={c.pose} motion={c.motion} alt="" style={{ height: 190, width: 'auto', marginTop: -24 }} />
      <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 36, letterSpacing: '-0.02em', marginTop: 22 }}>{c.title}</div>
      <div style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--dim)', marginTop: 10, maxWidth: 520 }}>{c.body}</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 26 }}>
        <Action action={c.primary} onRetry={onRetry} onPeriod={onPeriod} className="mk-press97" style={{ ...button, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }} />
        {c.secondary && <Action action={c.secondary} onRetry={onRetry} onPeriod={onPeriod} className="mk-press97" style={{ ...button, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)' }} />}
      </div>
      {c.footer && <div style={{ ...mono, fontSize: 12, color: 'var(--dim)', marginTop: 18 }}>{c.footer}</div>}
    </div>
  );
}

export function BoardStateMobile({ state, period, syncing, onRetry, onPeriod }: Props) {
  if (state === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading">
        <div style={{ height: 18 }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, alignItems: 'end', height: 250, padding: '0 16px' }}>
          {[248, 212, 184, 160, 140].map((h) => (
            <div key={h} style={{ height: h, borderRadius: 9999, background: 'var(--raise)', display: 'flex', justifyContent: 'center', paddingTop: 6 }}>
              <div style={{ width: 48, height: 48, borderRadius: 9999, background: bar }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '22px 12px 0' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 24, background: 'var(--raise)', padding: '10px 16px 10px 12px' }}>
              <div style={{ width: 28, height: 16, borderRadius: 8, background: bar }} />
              <div style={{ flex: 'none', width: 44, height: 44, borderRadius: 9999, background: bar }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ width: '60%', height: 14, borderRadius: 8, background: bar }} />
                <div style={{ width: '35%', height: 12, borderRadius: 8, background: bar }} />
              </div>
              <div style={{ width: 54, height: 16, borderRadius: 8, background: bar }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const c = boardStateCopy(state, { period, syncing });
  const full: React.CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9999, fontWeight: 800 };
  return (
    <div style={{ padding: '18px 12px 0' }}>
      <div role={state === 'error' ? 'alert' : undefined} style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '22px 20px 18px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '10px 4px 4px' }}>
          <Mascot pose={c.pose} motion={c.motion} alt="" style={{ height: 160, width: 'auto' }} />
          <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 26, lineHeight: 1.1, letterSpacing: '-0.02em', marginTop: 18 }}>{c.title}</div>
          <div style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.72, marginTop: 8 }}>{c.body}</div>
          <Action action={c.primary} onRetry={onRetry} onPeriod={onPeriod} className="m3-press" style={{ ...full, height: 54, marginTop: 18, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16 }} />
          {c.secondary && <Action action={c.secondary} onRetry={onRetry} onPeriod={onPeriod} className="m3-press" style={{ ...full, height: 50, marginTop: 8, background: 'var(--m3-inv-2)', color: 'var(--m3-inv-fg)', fontSize: 15 }} />}
          {c.footer && <div style={{ fontSize: 13, opacity: 0.6, marginTop: 12 }}>{c.footer}</div>}
        </div>
      </div>
    </div>
  );
}
