'use client';

import { useQuery } from '@tanstack/react-query';

import { explorerUrl } from '@/lib/chain';
import { MAKO_ADDRESS, ROUNDS_ADDRESS } from '@/lib/contract';
import { formatAgo, usdc2 } from '@/lib/pool-list';
import { growthPaths, type StatsWire } from '@/lib/stats';
import { useLiveNowSec } from '@/lib/use-live-clock';

// /stats ("proof of demand"): figures read from Monad testnet through Mako Market's Envio indexer of the pools and
// rounds contracts, and the gas-free actions Mako Market sponsored. Mako Market's own wallets are left out. A figure that
// cannot be read says so; nothing is estimated.

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const label: React.CSSProperties = { ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '0.06em', textTransform: 'uppercase' };
const BAR = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';
const int = (n: number) => n.toLocaleString('en-US');
const usdc = (s: string) => usdc2(BigInt(s));

function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: async (): Promise<StatsWire> => {
      const res = await fetch('/api/stats', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as StatsWire;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

type Figure = { label: string; value: string | null; note: string };

function figures(s: StatsWire): Figure[] {
  const i = s.indexed;
  return [
    { label: 'Mako wallets created', value: s.makoWallets === null ? null : int(s.makoWallets), note: 'one for each email sign-up' },
    { label: 'Wallets that used Mako Market', value: i ? int(i.wallets) : null, note: 'placed a bet, created a pool or entered a round' },
    { label: 'Bets placed', value: i ? int(i.bets) : null, note: i ? `by ${int(i.bettors)} ${i.bettors === 1 ? 'person' : 'people'}` : 'on the pools contract' },
    { label: 'Staked', value: i ? `${usdc(i.volume)}` : null, note: 'test USDC placed on the line' },
  ];
}

/// The desktop Adoption grid's gas-free and pool figures, for the mobile layout, which has no such grid.
function mobileExtra(s: StatsWire): Figure[] {
  const i = s.indexed;
  return [
    { label: 'Gas-free actions', value: s.gasFree ? int(s.gasFree.actions) : null, note: s.gasFree ? `sponsored by Mako Market, for ${int(s.gasFree.accounts)} accounts` : 'sponsored by Mako Market' },
    { label: 'Pools created', value: i ? int(i.communityPools) : null, note: 'by people using Mako Market' },
  ];
}

function IndexNote({ s }: { s: StatsWire }) {
  if (s.indexedStatus === 'ok') return null;
  return (
    <div role="status" style={{ marginTop: 18, padding: '14px 16px', borderRadius: 14, background: 'var(--raise)', fontSize: 14, lineHeight: 1.5 }}>
      {s.indexedStatus === 'not_configured'
        ? 'The on-chain index is being connected. Its figures appear here once it is live.'
        : 'The on-chain index cannot be read right now. Its figures are left out rather than guessed; try again shortly.'}
    </div>
  );
}

function Growth({ s, w, h }: { s: StatsWire; w: number; h: number }) {
  const g = s.indexed?.growth ?? [];
  const paths = growthPaths(g.map((d) => d.cumulativeWallets), w, h);
  if (!paths) return <div style={{ fontSize: 14, color: 'var(--dim)', padding: '24px 0' }}>{s.indexed ? 'No activity indexed yet.' : 'Unavailable until the index can be read.'}</div>;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={`Cumulative wallets, ${g[0].day} to ${g[g.length - 1].day}`}>
        <path d={paths.area} fill="color-mix(in srgb, var(--mako-signal) 22%, transparent)" />
        <path d={paths.line} fill="none" stroke="var(--mako-signal)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 6 }}>
        <span>{g[0].day}</span>
        <span>{g[g.length - 1].day}</span>
      </div>
    </div>
  );
}

function Categories({ s }: { s: StatsWire }) {
  const cats = [...(s.indexed?.categories ?? [])].filter((c) => c.bets > 0 || c.pools > 0).sort((a, b) => (BigInt(b.volume) > BigInt(a.volume) ? 1 : -1));
  if (cats.length === 0) return <div style={{ fontSize: 14, color: 'var(--dim)', padding: '18px 0' }}>{s.indexed ? 'No pools indexed yet.' : 'Unavailable until the index can be read.'}</div>;
  const top = BigInt(cats[0].volume) || 1n;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
      {cats.map((c) => (
        <div key={c.category}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ fontWeight: 700 }}>{c.category === 'Basketball' ? 'NBA' : c.category}</span>
            <span style={{ ...mono, color: 'var(--dim)' }}>
              {int(c.pools)} pools · {int(c.bets)} bets · {usdc(c.volume)} USDC
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 9999, background: BAR, marginTop: 5, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Number((BigInt(c.volume) * 100n) / top)}%`, background: 'var(--mako-signal)' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Rounds({ s, big }: { s: StatsWire; big: number }) {
  const r = s.indexed?.rounds ?? null;
  const settled = r ? r.up + r.down : 0;
  // Played = finished (settled or refunded); the rest are scheduled, open or waiting to settle.
  const played = r ? settled + r.refunded : 0;
  const pending = r ? r.scheduled - played : 0;
  const refundNote = r
    ? [r.tied && `${int(r.tied)} tied`, r.oneSided && `${int(r.oneSided)} one-sided`, r.noPrice && `${int(r.noPrice)} without a price`].filter(Boolean).join(', ')
    : '';
  const tile = (t: string, value: string | null, note: string) => (
    <div key={t} style={{ padding: '18px 18px 16px', borderRadius: 16, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
      <div style={label}>{t}</div>
      <div style={{ ...display, fontSize: big, lineHeight: 1, marginTop: 12, fontVariantNumeric: 'tabular-nums' }}>{value ?? 'n/a'}</div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 8 }}>{value === null ? 'unavailable right now' : note}</div>
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
      {tile('Rounds played', r ? int(played) : null, r ? `${int(settled)} settled · ${int(r.refunded)} refunded${pending > 0 ? ` · ${int(pending)} in progress` : ''}` : '')}
      {tile('Results', r ? `${int(r.up)} / ${int(r.down)}` : null, 'UP / DOWN wins')}
      {tile('Entries', r ? int(r.entries) : null, r ? `by ${int(r.entrants)} ${r.entrants === 1 ? 'person' : 'people'}` : '')}
      {tile('Staked on rounds', r ? usdc(r.volume) : null, r ? `${int(r.claims)} ${r.claims === 1 ? 'claim' : 'claims'} paid ${usdc(r.claimed)} USDC` : '')}
      {r && r.refunded > 0 ? tile('Refunded', int(r.refunded), refundNote) : null}
    </div>
  );
}

function Footer({ s, now }: { s: StatsWire; now: number | null }) {
  const i = s.indexed;
  return (
    <p style={{ ...mono, fontSize: 11, color: 'var(--dim)', lineHeight: 1.6, marginTop: 26 }}>
      {i ? `Indexed through block ${int(i.updatedBlock)} with Envio HyperIndex. ` : ''}
      {now !== null ? `Figures read ${formatAgo(now - s.readAt).toLowerCase()}. On-chain figures refresh every minute; Mako wallets and gas-free actions every 15 minutes. ` : ''}
      Mako Market&apos;s own wallets (operator and test accounts) are left out. Gas-free actions come from Mako Market&apos;s
      sponsor records; each is a transaction on Monad testnet.
    </p>
  );
}

export function StatsClient() {
  const q = useStats();
  const now = useLiveNowSec();
  const s = q.data;

  const head = (size: number) => (
    <>
      <div style={label}>On-chain · verifiable · Monad testnet</div>
      <h1 style={{ margin: '10px 0 0', ...display, fontSize: size, lineHeight: 0.95, letterSpacing: '-0.04em' }}>
        Proof of <span style={{ color: 'var(--mako-signal)' }}>demand.</span>
      </h1>
      <p style={{ margin: '14px 0 0', fontSize: 16, lineHeight: 1.55, color: 'var(--dim)', maxWidth: 560 }}>
        Real wallets, read from the chain through Mako Market&apos;s indexer of its{' '}
        <a href={explorerUrl('address', MAKO_ADDRESS)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--mako-canvas-fg)' }}>
          pools contract
        </a>
        {ROUNDS_ADDRESS ? (
          <>
            {' '}and its{' '}
            <a href={explorerUrl('address', ROUNDS_ADDRESS)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--mako-canvas-fg)' }}>
              rounds contract
            </a>
          </>
        ) : null}
        . Counts only: no wallet, bet or claim is listed.
      </p>
    </>
  );

  if (q.isError && !s) {
    return (
      <div role="alert" style={{ padding: '48px 16px', textAlign: 'center' }}>
        <h1 style={{ margin: 0, ...display, fontSize: 36 }}>Can&apos;t load the stats right now</h1>
        <p style={{ color: 'var(--dim)', marginTop: 10 }}>Mako Market couldn&apos;t reach its server. Nothing here is estimated, so nothing is shown.</p>
        <button type="button" onClick={() => void q.refetch()} className="mk-press97" style={{ marginTop: 18, height: 48, padding: '0 22px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', ...display, fontSize: 15 }}>
          Try again
        </button>
      </div>
    );
  }

  if (!s) {
    return (
      <div aria-busy="true" aria-label="Loading" style={{ padding: '28px 16px' }}>
        <div style={{ width: 300, maxWidth: '100%', height: 54, borderRadius: 10, background: BAR }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginTop: 24 }}>
          {[0, 1, 2, 3].map((k) => (
            <div key={k} style={{ height: 110, borderRadius: 16, background: BAR }} />
          ))}
        </div>
      </div>
    );
  }

  const figs = figures(s);
  const figure = (f: Figure, big: number) => (
    <div key={f.label} style={{ padding: '18px 18px 16px', borderRadius: 16, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
      <div style={label}>{f.label}</div>
      <div style={{ ...display, fontSize: big, lineHeight: 1, marginTop: 12, fontVariantNumeric: 'tabular-nums' }}>{f.value ?? 'n/a'}</div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 8 }}>{f.value === null ? 'unavailable right now' : f.note}</div>
    </div>
  );
  const section = (n: string, title: string, sub: string, body: React.ReactNode) => (
    <section style={{ marginTop: 34, paddingTop: 18, boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>{n}</span>
        <h2 style={{ margin: 0, ...display, fontSize: 24, letterSpacing: '-0.02em' }}>{title}</h2>
        <span style={label}>{sub}</span>
      </div>
      <div style={{ marginTop: 12 }}>{body}</div>
    </section>
  );
  const i = s.indexed;

  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <div style={{ padding: '26px 0 48px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 36, alignItems: 'end' }}>
          <div>{head(72)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{figs.map((f) => figure(f, 40))}</div>
        </div>
        <IndexNote s={s} />
        {section('01', 'Growth', 'Cumulative wallets', <Growth s={s} w={1000} h={180} />)}
        {section(
          '02',
          'Adoption',
          'Pools and payouts',
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 36 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {figure({ label: 'Pools created', value: i ? int(i.communityPools) : null, note: 'by people using Mako Market' }, 30)}
              {figure({ label: 'Pools settled', value: i ? int(i.communityPoolsSettled) : null, note: i ? `${int(i.communityPoolsRefunded)} refunded` : '' }, 30)}
              {figure({ label: 'Claims paid', value: i ? int(i.claims) : null, note: i ? `${usdc(i.claimed)} USDC` : '' }, 30)}
              {figure({ label: 'Gas-free actions', value: s.gasFree ? int(s.gasFree.actions) : null, note: s.gasFree ? `sponsored by Mako Market, for ${int(s.gasFree.accounts)} accounts` : 'sponsored by Mako Market' }, 30)}
            </div>
            <div>
              <div style={label}>By category</div>
              <Categories s={s} />
            </div>
          </div>,
        )}
        {section('03', 'Rounds', '15-minute BTC/USD', <Rounds s={s} big={30} />)}
        <Footer s={s} now={now} />
        </div>
      </div>

      <div className="mk-mob mk-m" style={{ padding: '6px 16px 120px' }}>
        {head(44)}
        {/* Mobile has no Adoption grid, so its gas-free and pool figures join the headline ones here. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 20 }}>{[...figs, ...mobileExtra(s)].map((f) => figure(f, 28))}</div>
        <IndexNote s={s} />
        {section('01', 'Growth', 'Wallets', <Growth s={s} w={360} h={140} />)}
        {section('02', 'Adoption', 'By category', <Categories s={s} />)}
        {section('03', 'Rounds', 'BTC/USD', <Rounds s={s} big={24} />)}
        <Footer s={s} now={now} />
      </div>
    </>
  );
}
