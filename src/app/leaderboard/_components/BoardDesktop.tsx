'use client';

import { BOARD_COPY } from '@/lib/leaderboard/board-copy';
import { PERIODS, SCOPES, SORTS, type PlayerView } from '@/lib/leaderboard/board-view';

import { BoardStateDesktop, DESK_COLS } from './BoardState';
import { TONE_FG, type BoardProps } from './props';

// Leaderboard desktop (12a, terminal look): title, scope / period / sort pills, a podium for the top three, the
// signed-in player's pinned row, then everyone from #4 as hairline rows. Players are plain text: there are no
// profile pages yet (13a), so nothing here is a link and rows have no hover or arrow.

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const ellipsis: React.CSSProperties = { minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

type Option<K extends string> = { key: K; label: string; comingSoon?: true };

function Pills<K extends string>({ label, options, value, onPick }: { label: string; options: readonly Option<K>[]; value: K; onPick: (k: K) => void }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)' }}>
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
            style={{ height: 34, padding: '0 14px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'transparent', color: on ? 'var(--mako-canvas)' : 'var(--dim)', ...mono, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', ...(off ? { opacity: 0.55, cursor: 'not-allowed' } : null) }}
          >
            {off ? `${o.label} · ${BOARD_COPY.comingSoon}` : o.label}
          </button>
        );
      })}
    </div>
  );
}

const PODIUM_HEIGHT = [200, 240, 180];

function PodiumCard({ p, place, metric }: { p: PlayerView; place: number; metric: string }) {
  const first = place === 1;
  return (
    <div style={{ textAlign: 'left', borderRadius: 14, background: 'var(--raise)', color: 'var(--mako-canvas-fg)', boxShadow: first ? 'inset 0 0 0 2px var(--mako-signal)' : 'inset 0 0 0 1px var(--line)', padding: 18, height: PODIUM_HEIGHT[place], display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 52, height: 52, borderRadius: 9999, background: p.colour, color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 22 }}>
          {p.initial}
        </span>
        <div style={{ minWidth: 0 }}>
          <span style={{ display: 'inline-flex', height: 22, alignItems: 'center', padding: '0 9px', borderRadius: 9999, background: first ? 'var(--mako-signal)' : 'var(--raise2)', color: first ? '#000' : 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700 }}>#{p.rank}</span>
          <div style={{ ...display, fontSize: 20, ...ellipsis }}>{p.name}</div>
        </div>
      </div>
      <div style={{ marginTop: 'auto' }}>
        <div style={{ ...mono, fontSize: 11, opacity: 0.7 }}>{metric}</div>
        <div style={{ ...display, fontSize: 36, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{p.value}</div>
      </div>
    </div>
  );
}

function Row({ p }: { p: PlayerView }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: DESK_COLS, gap: 18, alignItems: 'center', padding: '13px 20px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <span style={{ ...mono, fontSize: 15, fontWeight: 700, color: 'var(--dim)' }}>#{p.rank}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 34, height: 34, borderRadius: 9999, background: p.colour, color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 14 }}>
          {p.initial}
        </span>
        <span style={{ fontWeight: 700, ...ellipsis }}>{p.name}</span>
        {p.creator && (
          <span style={{ flex: 'none', height: 20, display: 'flex', alignItems: 'center', padding: '0 8px', borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)', ...mono, fontSize: 10, fontWeight: 700, color: 'var(--dim)' }}>{BOARD_COPY.creator}</span>
        )}
      </span>
      <span style={{ textAlign: 'right', ...mono, fontSize: 15, fontWeight: 700, color: TONE_FG[p.profit.tone] }}>{p.profit.text}</span>
      <span style={{ textAlign: 'right', ...mono, fontSize: 14 }}>{p.bets}</span>
      <span style={{ textAlign: 'right', ...mono, fontSize: 14 }}>{p.volume}</span>
      <span />
    </div>
  );
}

export function BoardDesktop({ view, state, scope, setScope, period, setPeriod, sort, setSort, syncing, retry }: BoardProps) {
  const metric = SORTS.find((s) => s.key === sort)!.metric;
  const me = view?.me ?? null;
  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, padding: '18px 4px 18px' }}>
        <div>
          <h1 style={{ margin: 0, ...display, fontSize: 64, lineHeight: 1, letterSpacing: '-0.04em' }}>{BOARD_COPY.title}</h1>
          <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 10 }}>{BOARD_COPY.subtitleDesktop}</div>
          {syncing && (
            <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, ...mono, fontSize: 11, color: 'var(--dim)' }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--mako-gold)' }} />
              {BOARD_COPY.syncing}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 18px', flexWrap: 'wrap' }}>
        <Pills label="Markets" options={SCOPES} value={scope} onPick={setScope} />
        <Pills label="Period" options={PERIODS} value={period} onPick={setPeriod} />
        <span style={{ marginLeft: 'auto', ...mono, fontSize: 11, color: 'var(--dim)' }}>{BOARD_COPY.sortLabel}</span>
        <Pills label="Sort" options={SORTS} value={sort} onPick={setSort} />
      </div>

      {state === 'ready' && view ? (
        <>
          <div style={{ padding: '0 4px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.15fr 1fr', gap: 14, alignItems: 'end', marginTop: 6 }}>
              {view.podium.map((p, place) => (p ? <PodiumCard key={p.actor} p={p} place={place} metric={metric} /> : <div key={`empty-${place}`} aria-hidden="true" />))}
            </div>
          </div>

          {me && (
            <div style={{ margin: '22px 4px 0', display: 'grid', gridTemplateColumns: DESK_COLS, gap: 18, alignItems: 'center', padding: '14px 16px', borderRadius: 14, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
              <span style={{ ...display, fontSize: 22 }}>#{me.player.rank}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span aria-hidden="true" style={{ flex: 'none', width: 34, height: 34, borderRadius: 9999, background: '#000', color: 'var(--mako-signal)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display }}>
                  {me.player.initial}
                </span>
                <span style={{ fontWeight: 800, ...ellipsis }}>
                  {me.player.name} · {BOARD_COPY.you}
                </span>
              </span>
              <span style={{ textAlign: 'right', ...mono, fontSize: 15, fontWeight: 700 }}>{me.player.profit.text}</span>
              <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700 }}>{me.player.bets}</span>
              <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700 }}>{me.player.volume}</span>
              <span />
            </div>
          )}

          {view.restDesktop.length > 0 && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: DESK_COLS, gap: 18, padding: '16px 20px 10px', ...mono, fontSize: 10, color: 'var(--dim)' }}>
                <span>{BOARD_COPY.columns.rank}</span>
                <span>{BOARD_COPY.columns.player}</span>
                <span style={{ textAlign: 'right' }}>{BOARD_COPY.columns.profit}</span>
                <span style={{ textAlign: 'right' }}>{BOARD_COPY.columns.bets}</span>
                <span style={{ textAlign: 'right' }}>{BOARD_COPY.columns.volume}</span>
                <span />
              </div>
              {view.restDesktop.map((p) => (
                <Row key={p.actor} p={p} />
              ))}
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginTop: view.restDesktop.length > 0 ? 0 : 22, padding: '14px 4px 0', boxShadow: 'inset 0 1px 0 var(--line)', ...mono, fontSize: 11, color: 'var(--dim)' }}>
            <span>{BOARD_COPY.footnote}</span>
            <span style={{ flex: 'none' }}>{BOARD_COPY.cadence}</span>
          </div>
        </>
      ) : (
        <BoardStateDesktop state={state === 'ready' ? 'loading' : state} period={period} syncing={syncing} onRetry={retry} onPeriod={setPeriod} />
      )}
    </div>
  );
}
