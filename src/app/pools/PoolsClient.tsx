'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ListStateDesktop, ListStateMobile } from '@/components/ListState';
import { PoolMobileCard, poolHref } from '@/components/pools/PoolMobileCard';
import { MarketType } from '@/lib/contract';
import { useMarkets } from '@/lib/hooks';
import {
  buildPoolList,
  CAT_STYLE,
  catTitle,
  claimable,
  CLOSED_WINDOW_SEC,
  formatPays,
  noOpenPoolsTitle,
  POOL_FILTERS,
  positionLabel,
  STATE_PILL,
  usdc2,
  type PoolFilter,
  type PoolRow,
  type PoolSort,
} from '@/lib/pool-list';
import { useAddressNames } from '@/lib/use-address-names';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { usePoolLabels, type SideLabels } from '@/lib/use-pool-labels';
import { accountAddress, useUser } from '@/lib/use-user';
import { useUserBets } from '@/lib/use-user-bets';
import { formatAddress } from '@/lib/user-display';

// Pools (8a): every V4 pool that is open, grouped by when it closes, plus the ones that closed in the last week.
// Desktop is a table, mobile a stack of cards; both render, and the shell's width switch shows one.

const SORTS: readonly { key: PoolSort; label: string }[] = [
  { key: 'closing', label: 'Closing soon' },
  { key: 'pool', label: 'Biggest pool' },
  { key: 'bettors', label: 'Most bettors' },
];
const NEXT_SORT: Record<PoolSort, PoolSort> = { closing: 'pool', pool: 'bettors', bettors: 'closing' };

/// Until the redesigned create flow (10a) replaces it, "Create pool" opens the current one.
const CREATE_HREF = '/pools/new';

type Labels = SideLabels;
type ClosedState = Exclude<PoolRow['state'], 'open'>;

export function PoolsClient() {
  const { markets, isLoading, isError, refetch } = useMarkets();
  const now = useLiveNowSec();
  const { user } = useUser();
  const account = user ? accountAddress(user) : null;
  const [filter, setFilter] = useState<PoolFilter>('ALL');
  const [sort, setSort] = useState<PoolSort>('closing');

  // The pools the page can show, recomputed once a minute rather than every tick, so the reads below keep a
  // stable key.
  const minute = now === null ? null : Math.floor(now / 60);
  const onPage = useMemo(
    () => (minute === null ? [] : markets.filter((m) => minute * 60 - Number(m.bettingCloseTime) <= CLOSED_WINDOW_SEC + 60)),
    [markets, minute],
  );
  const ids = useMemo(() => onPage.map((m) => m.id), [onPage]);
  const bets = useUserBets(ids, account);
  const makoIds = useMemo(() => onPage.filter((m) => m.mType === MarketType.MAKO).map((m) => m.id.toString()), [onPage]);
  const labelsOf = usePoolLabels(makoIds);
  const names = useAddressNames(useMemo(() => onPage.filter((m) => m.mType !== MarketType.MAKO).map((m) => m.creator), [onPage]));

  const list = now === null ? null : buildPoolList(markets, now, filter, sort, bets);
  const byOf = (r: PoolRow) => (r.cat === 'MAKO' ? 'Mako Market' : (names.get(r.creator.toLowerCase()) ?? formatAddress(r.creator)));

  const state: 'loading' | 'error' | 'empty' | 'ready' =
    isError ? 'error' : isLoading || list === null ? 'loading' : list.groups.length === 0 && filter === 'ALL' ? 'empty' : 'ready';

  const view = { list, state, filter, setFilter, sort, setSort, labelsOf, byOf, retry: refetch };
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <PoolsDesktop {...view} />
      </div>
      <div className="mk-mob mk-m">
        <PoolsMobile {...view} />
      </div>
    </>
  );
}

type ViewProps = {
  list: ReturnType<typeof buildPoolList> | null;
  state: 'loading' | 'error' | 'empty' | 'ready';
  filter: PoolFilter;
  setFilter: (f: PoolFilter) => void;
  sort: PoolSort;
  setSort: (s: PoolSort) => void;
  labelsOf: (r: PoolRow) => Labels;
  byOf: (r: PoolRow) => string;
  retry: () => void;
};

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const COLS = 'minmax(0,1fr) 170px 212px 120px 92px 20px';

// ---------------------------------------------------------------------------------------------------------------
// Desktop

function PoolsDesktop({ list, state, filter, setFilter, sort, setSort, labelsOf, byOf, retry }: ViewProps) {
  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, padding: '18px 4px 22px' }}>
        <div>
          <h1 style={{ margin: 0, ...display, fontSize: 64, lineHeight: 1, letterSpacing: '-0.04em' }}>Pools</h1>
          <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 10 }}>Bet YES or NO on crypto, sport, forex, commodities and stocks. Open for hours to days.</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 22, ...mono, fontSize: 12, paddingBottom: 6 }}>
          {list && state === 'ready' && (
            <>
              <span>
                <span style={{ color: 'var(--dim)' }}>OPEN</span> <span style={{ fontWeight: 700 }}>{list.openCount} POOLS</span>
              </span>
              <span>
                <span style={{ color: 'var(--dim)' }}>IN POOLS</span> <span style={{ fontWeight: 700 }}>{usdc2(list.openTotal)} USDC</span>
              </span>
            </>
          )}
          <Link
            href={CREATE_HREF}
            className="mk-press96"
            style={{ height: 44, padding: '0 20px', borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', ...display, fontSize: 15, boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', textDecoration: 'none' }}
          >
            Create pool market
          </Link>
        </div>
      </div>

      {state === 'ready' && list ? (
        <>
          <div data-tour-anchor="pools-topics" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '14px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
            {POOL_FILTERS.map((c, i) => {
              const on = c === filter;
              return (
                <button
                  key={c}
                  onClick={() => setFilter(c)}
                  aria-pressed={on}
                  data-tour-point={i === 1 ? 'pools-topics' : undefined}
                  className="mk-press96"
                  style={{ flex: 'none', height: 34, padding: '0 14px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'var(--raise)', color: on ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 800, letterSpacing: '0.12em' }}
                >
                  {c}
                  <span style={{ ...mono, fontSize: 11, fontWeight: 500, opacity: 0.7 }}>{list.counts[c]}</span>
                </button>
              );
            })}
            <div role="group" aria-label="Sort" style={{ marginLeft: 'auto', display: 'flex', gap: 2, padding: 3, borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)' }}>
              {SORTS.map((o) => {
                const on = o.key === sort;
                return (
                  <button
                    key={o.key}
                    onClick={() => setSort(o.key)}
                    aria-pressed={on}
                    className="mk-press96"
                    style={{ height: 28, padding: '0 12px', borderRadius: 9999, background: on ? 'var(--raise2)' : 'transparent', color: on ? 'var(--mako-canvas-fg)' : 'var(--dim)', ...mono, fontSize: 11, fontWeight: 700 }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 20, padding: '10px 4px', boxShadow: 'inset 0 1px 0 var(--line)', ...mono, fontSize: 10, color: 'var(--dim)' }}>
            <span>MARKET</span>
            <span>YES · NO SPLIT</span>
            <span>BET · PAYS PER 1 USDC</span>
            <span style={{ textAlign: 'right' }}>POOL · USDC</span>
            <span style={{ textAlign: 'right' }}>CLOSES</span>
            <span />
          </div>
          {list.groups.length === 0 && (
            <div style={{ padding: '56px 4px', boxShadow: 'inset 0 1px 0 var(--line)', textAlign: 'center' }}>
              <div style={{ ...display, fontSize: 24 }}>{noOpenPoolsTitle(filter)}</div>
              <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 8 }}>Pools open when a creator makes one. Try another category, or make one yourself.</div>
            </div>
          )}
          {list.groups.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 4px 10px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
                <h2 style={{ margin: 0, ...display, fontSize: 22, letterSpacing: '-0.02em' }}>{g.title}</h2>
                <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>{g.rows.length}</span>
              </div>
              {g.rows.map((r) => (
                <DesktopRow key={r.id.toString()} row={r} labels={labelsOf(r)} by={byOf(r)} />
              ))}
            </section>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 4px 0', boxShadow: 'inset 0 1px 0 var(--line)', ...mono, fontSize: 11, color: 'var(--dim)' }}>
            <span>Payouts are estimates until the pool closes. Fees are taken only if the pool settles.</span>
            <span>Winnings are claimed from Me.</span>
          </div>
        </>
      ) : (
        <div style={{ boxShadow: 'inset 0 1px 0 var(--line)' }}>
          <ListStateDesktop kind="pools" state={state === 'ready' ? 'loading' : state} onRetry={retry} />
        </div>
      )}
    </div>
  );
}

function DesktopRow({ row: r, labels, by }: { row: PoolRow; labels: Labels; by: string }) {
  const cat = CAT_STYLE[r.cat];
  const open = r.state === 'open';
  const pos = r.position;
  const posFg = !open ? 'var(--dim)' : pos?.kind === 'staked' && pos.no > 0n && pos.yes === 0n ? 'var(--mako-red)' : pos?.kind === 'staked' && pos.yes > 0n && pos.no > 0n ? 'var(--mako-canvas-fg)' : 'var(--up-text)';
  const claim = claimable(pos);
  const sideBtn: React.CSSProperties = { flex: 1, minWidth: 0, height: 40, borderRadius: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, ...mono, fontSize: 13, fontWeight: 700, color: '#000', boxShadow: 'var(--edge)', textDecoration: 'none' };
  return (
    <div className="mk-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 20, alignItems: 'center', padding: '16px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 14 }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 36, height: 36, borderRadius: 9999, background: cat.bg, color: cat.fg, boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...mono, fontSize: 10, fontWeight: 700 }}>
          {cat.abbr}
        </span>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          <Link href={poolHref(r.id)} className="mk-rowlink" style={{ maxWidth: '100%', ...display, fontSize: 17, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
            {r.question}
          </Link>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: '100%' }}>
            <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {r.cat} · {r.bettors} {r.bettors === 1 ? 'bettor' : 'bettors'} · by {by}
            </span>
            {pos && (
              <span style={{ flex: 'none', height: 20, display: 'flex', alignItems: 'center', padding: '0 9px', borderRadius: 9999, boxShadow: `inset 0 0 0 1px ${posFg}`, color: posFg, ...mono, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
                {positionLabel(pos)}
              </span>
            )}
          </span>
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, ...mono, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--up-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {labels.yes} {r.yesPct}%
          </span>
          <span style={{ color: 'var(--mako-red)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {r.noPct}% {labels.no}
          </span>
        </div>
        <div style={{ display: 'flex', height: 4, borderRadius: 9999, overflow: 'hidden', background: 'var(--mako-red)', marginTop: 7 }}>
          <div style={{ width: `${r.yesPct}%`, background: 'var(--mako-signal)' }} />
        </div>
      </div>
      <div className="mk-over" style={{ display: 'flex', gap: 6 }}>
        {open ? (
          <>
            <Link href={`${poolHref(r.id)}?side=yes`} className="mk-press96" style={{ ...sideBtn, background: 'var(--mako-signal)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labels.yes}</span> <span style={{ fontWeight: 500 }}>{formatPays(r.yesPays)}</span>
            </Link>
            <Link href={`${poolHref(r.id)}?side=no`} className="mk-press96" style={{ ...sideBtn, background: 'var(--mako-red)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labels.no}</span> <span style={{ fontWeight: 500 }}>{formatPays(r.noPays)}</span>
            </Link>
          </>
        ) : (
          <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 'none', height: 24, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 9999, background: STATE_PILL[r.state as ClosedState].bg, color: '#000', boxShadow: 'var(--edge)', fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
              {STATE_PILL[r.state as ClosedState].label}
            </span>
            {claim !== null && (
              <Link href={poolHref(r.id)} className="mk-press96" style={{ height: 36, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', ...display, fontSize: 13, boxShadow: 'var(--edge)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
                Claim {usdc2(claim)} USDC
              </Link>
            )}
          </span>
        )}
      </div>
      <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700 }}>{usdc2(r.pool)}</span>
      <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700, color: !open ? 'var(--dim)' : r.closingSoon ? 'var(--mako-red)' : 'var(--mako-canvas-fg)', whiteSpace: 'nowrap' }}>{r.closes}</span>
      <span aria-hidden="true" style={{ textAlign: 'right', ...display, fontSize: 16 }}>
        →
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mobile

const ARROW_UP_RIGHT = 'M7 17L17 7M9 7h8v8';

function PoolsMobile({ list, state, filter, setFilter, sort, setSort, labelsOf, retry }: ViewProps) {
  // Mobile lists open pools only; closed ones and their claims are on Me (the design's "Winnings are claimed from Me").
  const groups = list ? list.groups.filter((g) => g.title !== 'Closed') : [];
  const sortLabel = SORTS.find((o) => o.key === sort)!.label;
  return (
    <div style={{ paddingBottom: 24 }}>
      <div style={{ padding: '6px 20px 0' }}>
        <h1 style={{ margin: 0, ...display, fontSize: 40, lineHeight: 1, letterSpacing: '-0.035em' }}>Pools</h1>
        <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 8 }}>Bet YES or NO on what happens next.</div>
      </div>

      {state === 'ready' && list ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '18px 16px 0' }}>
            <div style={{ position: 'relative', borderRadius: '28px 28px 28px 10px', background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', padding: '16px 16px 14px', minHeight: 112 }}>
              <CornerArrow bg="#000" fg="var(--mako-signal)" />
              <div style={{ ...display, fontSize: 48, lineHeight: 1, letterSpacing: '-0.03em', marginTop: 6 }}>{list.openCount}</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8 }}>Open now</div>
            </div>
            <div style={{ position: 'relative', borderRadius: '28px 28px 10px 28px', background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '16px 16px 14px', minHeight: 112 }}>
              <CornerArrow bg="var(--m3-inv-fg)" fg="var(--m3-inv)" />
              <div style={{ ...display, fontSize: 30, lineHeight: 1, letterSpacing: '-0.03em', marginTop: 24, fontVariantNumeric: 'tabular-nums' }}>
                {Math.floor(Number(list.openTotal) / 1e6).toLocaleString('en-US')}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8 }}>USDC in play</div>
            </div>
          </div>
          <div data-tour-anchor="pools-topics" className="no-scrollbar" style={{ display: 'flex', gap: 8, padding: '18px 16px 4px', overflowX: 'auto', scrollbarWidth: 'none' }}>
            {POOL_FILTERS.map((c, i) => {
              const on = c === filter;
              return (
                <button
                  key={c}
                  onClick={() => setFilter(c)}
                  aria-pressed={on}
                  data-tour-point={i === 1 ? 'pools-topics' : undefined}
                  className="m3-press"
                  style={{ flex: 'none', height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderRadius: 9999, background: on ? 'var(--m3-inv)' : 'var(--raise)', color: on ? 'var(--m3-inv-fg)' : 'var(--mako-canvas-fg)', boxShadow: on ? 'var(--edge)' : 'none', fontSize: 14, fontWeight: 700, transition: 'background-color 250ms cubic-bezier(0.2,0,0,1)' }}
                >
                  {catTitle(c)}
                  <span style={{ minWidth: 20, height: 20, padding: '0 5px', borderRadius: 9999, background: on ? 'var(--mako-signal)' : 'var(--raise2)', color: on ? '#000' : 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>
                    {list.counts[c]}
                  </span>
                </button>
              );
            })}
          </div>
          {groups.length === 0 && (
            <div style={{ padding: '36px 20px 0', textAlign: 'center' }}>
              <div style={{ ...display, fontSize: 22 }}>{noOpenPoolsTitle(filter)}</div>
              <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 8 }}>Pools open when a creator makes one. Try another category, or make one yourself.</div>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '22px 20px 12px' }}>
                <span style={{ width: 28, height: 28, borderRadius: 9999, boxShadow: 'inset 0 0 0 1.5px var(--m3-outline)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 }}>{g.rows.length}</span>
                <h2 style={{ margin: 0, ...display, fontSize: 22, letterSpacing: '-0.02em' }}>{g.title}</h2>
                <button onClick={() => setSort(NEXT_SORT[sort])} aria-label={`Sorted by ${sortLabel.toLowerCase()}. Change sort`} style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: 'var(--dim)' }}>
                  {sortLabel} ▾
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 12px' }}>
                {g.rows.map((r) => (
                  <PoolMobileCard key={r.id.toString()} row={r} labels={labelsOf(r)} />
                ))}
              </div>
            </section>
          ))}
        </>
      ) : (
        <ListStateMobile kind="pools" state={state === 'ready' ? 'loading' : state} onRetry={retry} />
      )}

      <Link
        href={CREATE_HREF}
        aria-label="Create pool"
        className="m3-press m3-scale96"
        style={{ position: 'fixed', right: 16, bottom: 'calc(94px + env(safe-area-inset-bottom))', zIndex: 41, height: 60, display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px 0 18px', borderRadius: 22, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge), 0 10px 24px rgba(0,0,0,0.32)', fontSize: 16, fontWeight: 800, textDecoration: 'none' }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Create pool
      </Link>
    </div>
  );
}

function CornerArrow({ bg, fg }: { bg: string; fg: string }) {
  return (
    <span aria-hidden="true" style={{ position: 'absolute', top: 12, right: 12, width: 32, height: 32, borderRadius: 9999, background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d={ARROW_UP_RIGHT} />
      </svg>
    </span>
  );
}
