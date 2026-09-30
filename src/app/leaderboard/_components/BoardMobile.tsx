'use client';

import { BOARD_COPY } from '@/lib/leaderboard/board-copy';
import { betsText, NEXT_SORT, PERIODS, SCOPES, SORTS } from '@/lib/leaderboard/board-view';

import { BoardStateMobile } from './BoardState';
import type { BoardProps } from './props';

// Leaderboard mobile (12a, Material 3 Expressive): scope and period chips, the top five as bars, the signed-in
// player's inverse card with the gap to the next player, then everyone from #6. Every number shown is the one the
// board is sorted by. Players are plain text: there are no profile pages yet (13a), so nothing is tappable.

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const ellipsis: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

type Option<K extends string> = { key: K; label: string; comingSoon?: true };

function Chips<K extends string>({ label, options, value, onPick, padding }: { label: string; options: readonly Option<K>[]; value: K; onPick: (k: K) => void; padding: string }) {
  return (
    <div style={{ padding }}>
      <div role="group" aria-label={label} className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollbarWidth: 'none' }}>
        {options.map((o) => {
          const on = o.key === value;
          const off = o.comingSoon === true;
          return (
            <button
              key={o.key}
              onClick={off ? undefined : () => onPick(o.key)}
              disabled={off}
              aria-disabled={off || undefined}
              aria-pressed={on}
              className="m3-press"
              style={{ flex: 'none', height: 40, padding: '0 16px', borderRadius: 9999, background: on ? 'var(--m3-inv)' : 'var(--raise)', color: on ? 'var(--m3-inv-fg)' : 'var(--mako-canvas-fg)', boxShadow: on ? 'var(--edge)' : 'none', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', ...(off ? { opacity: 0.55, cursor: 'not-allowed' } : null) }}
            >
              {off ? `${o.label} · ${BOARD_COPY.comingSoon}` : o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const ARROW_UP_RIGHT = 'M7.5 16.5l9-9M9.5 7.5h7v7';

export function BoardMobile({ view, state, scope, setScope, period, setPeriod, sort, setSort, syncing, retry }: BoardProps) {
  const sortLabel = SORTS.find((s) => s.key === sort)!.label;
  const me = view?.me ?? null;
  return (
    <div style={{ paddingBottom: 24 }}>
      <div style={{ padding: '6px 20px 0' }}>
        <h1 style={{ margin: 0, ...display, fontSize: 40, lineHeight: 1, letterSpacing: '-0.035em' }}>{BOARD_COPY.title}</h1>
        <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 8 }}>{BOARD_COPY.subtitleMobile}</div>
        {syncing && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13, color: 'var(--dim)' }}>
            <span aria-hidden="true" style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: 'var(--mako-gold)' }} />
            {BOARD_COPY.syncing}
          </div>
        )}
      </div>
      <Chips label="Markets" options={SCOPES} value={scope} onPick={setScope} padding="14px 16px 0" />
      <Chips label="Period" options={PERIODS} value={period} onPick={setPeriod} padding="8px 16px 0" />

      {state === 'ready' && view ? (
        <>
          <div style={{ height: 18 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, alignItems: 'end', height: 250, padding: '0 16px' }}>
            {view.bars.map(({ player: p, heightPx, bg }) => (
              <div key={p.actor} style={{ height: heightPx, borderRadius: 9999, background: bg, color: '#000', boxShadow: 'var(--edge)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 0 14px' }}>
                <span aria-hidden="true" style={{ width: 48, height: 48, borderRadius: 9999, background: p.colour, color: '#000', boxShadow: `0 0 0 3px ${bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 18 }}>
                  {p.initial}
                </span>
                <span style={{ marginTop: 'auto', ...display, fontSize: 22 }}>{p.rank}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, padding: '10px 16px 0', textAlign: 'center' }}>
            {view.bars.map(({ player: p }) => (
              <div key={p.actor} style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, ...ellipsis }}>{p.name}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>{p.short}</div>
              </div>
            ))}
          </div>

          {me && (
            <div style={{ padding: '16px 12px 0' }}>
              <div style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span aria-hidden="true" style={{ flex: 'none', width: 48, height: 48, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 20 }}>
                    {me.player.initial}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, ...ellipsis }}>
                      {BOARD_COPY.youCard} · {me.player.name}
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.65 }}>{betsText(me.player.bets)}</div>
                  </div>
                  <div style={{ flex: 'none', textAlign: 'right' }}>
                    <div style={{ ...display, fontSize: 26, fontVariantNumeric: 'tabular-nums' }}>#{me.player.rank}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{me.player.value}</div>
                  </div>
                </div>
                {me.next && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 12, boxShadow: 'inset 0 1px 0 var(--m3-inv-2)', fontSize: 13, fontWeight: 600 }}>
                    <span aria-hidden="true" style={{ flex: 'none', width: 28, height: 28, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <path d={ARROW_UP_RIGHT} />
                      </svg>
                    </span>
                    {me.next}
                  </div>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 20px 12px' }}>
            <h2 style={{ margin: 0, ...display, fontSize: 22, letterSpacing: '-0.02em' }}>{BOARD_COPY.everyoneElse}</h2>
            <span style={{ marginLeft: 'auto' }}>
              <button onClick={() => setSort(NEXT_SORT[sort])} aria-label={`Sorted by ${sortLabel.toLowerCase()}. Change sort`} style={{ fontSize: 13, fontWeight: 600, color: 'var(--dim)' }}>
                {sortLabel} ▾
              </button>
            </span>
          </div>
          {view.restMobile.length === 0 ? (
            <div style={{ padding: '0 20px', fontSize: 14, color: 'var(--dim)' }}>{BOARD_COPY.nobodyElse}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 12px' }}>
              {view.restMobile.map((p) => (
                <div key={p.actor} style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', borderRadius: 24, background: 'var(--raise)', padding: '10px 16px 10px 12px' }}>
                  <span style={{ flex: 'none', width: 28, textAlign: 'center', ...display, fontSize: 16, color: 'var(--dim)' }}>{p.rank}</span>
                  <span aria-hidden="true" style={{ flex: 'none', width: 44, height: 44, borderRadius: 9999, background: p.colour, color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 17 }}>
                    {p.initial}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 15, fontWeight: 800, ...ellipsis }}>{p.name}</span>
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>{betsText(p.bets)}</span>
                  </span>
                  <span style={{ flex: 'none', fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{p.value}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <BoardStateMobile state={state === 'ready' ? 'loading' : state} period={period} syncing={syncing} onRetry={retry} onPeriod={setPeriod} />
      )}
    </div>
  );
}
