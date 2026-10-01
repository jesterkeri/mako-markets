'use client';

import Link from 'next/link';

import { CAT_STYLE, catTitle, formatPays, positionLabel, usdc2, type PoolRow } from '@/lib/pool-list';
import type { SideLabels } from '@/lib/use-pool-labels';

// One open pool as a mobile card (8a): an inverse card with the category chip, the countdown, the question, the
// two sides with what each pays per 1 USDC, and the pool size. Used by Pools and by Home's "Pools closing soon".

export const poolHref = (id: bigint) => `/pools/${id}`;

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

export function PoolMobileCard({ row: r, labels }: { row: PoolRow; labels: SideLabels }) {
  const cat = CAT_STYLE[r.cat];
  const pos = r.position;
  const side: React.CSSProperties = { flex: 1, minWidth: 0, height: 56, borderRadius: 20, color: '#000', boxShadow: 'var(--m3-btn-edge)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' };
  const sideName: React.CSSProperties = { maxWidth: '90%', fontSize: 12, fontWeight: 700, opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const sidePays: React.CSSProperties = { ...display, fontSize: 20, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' };
  const cap = (s: string) => (s === 'YES' ? 'Yes' : s === 'NO' ? 'No' : s);
  return (
    <div className="m3-press" style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '18px 18px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ height: 28, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 0 4px', borderRadius: 9999, background: cat.bg, color: cat.fg, boxShadow: 'var(--edge)', fontSize: 12, fontWeight: 800 }}>
          <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 9999, background: 'rgba(0,0,0,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8 }}>
            {cat.abbr}
          </span>
          {catTitle(r.cat)}
        </span>
        <span style={{ marginLeft: 'auto', height: 28, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.closingSoon ? 'var(--mako-red)' : 'inherit' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2 2M9 2h6" />
          </svg>
          {r.closes}
        </span>
      </div>
      <Link href={poolHref(r.id)} className="mk-rowlink" style={{ display: 'block', ...display, fontSize: 22, lineHeight: 1.15, letterSpacing: '-0.02em', marginTop: 14, color: 'inherit', textDecoration: 'none' }}>
        {r.question}
      </Link>
      <div className="mk-over" style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Link href={`${poolHref(r.id)}?side=yes`} className="m3-press m3-scale96" style={{ ...side, background: 'var(--mako-signal)' }}>
          <span style={sideName}>
            {cap(labels.yes)} {r.yesPct}%
          </span>
          <span style={sidePays}>{formatPays(r.yesPays) || cap(labels.yes)}</span>
        </Link>
        <Link href={`${poolHref(r.id)}?side=no`} className="m3-press m3-scale96" style={{ ...side, background: 'var(--mako-red)' }}>
          <span style={sideName}>
            {cap(labels.no)} {r.noPct}%
          </span>
          <span style={sidePays}>{formatPays(r.noPays) || cap(labels.no)}</span>
        </Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ opacity: 0.72 }}>{usdc2(r.pool)} USDC</span>
        <span aria-hidden="true" style={{ width: 4, height: 4, borderRadius: '50%', background: 'currentColor', opacity: 0.72 }} />
        <span style={{ opacity: 0.72, whiteSpace: 'nowrap' }}>
          {r.bettors} {r.bettors === 1 ? 'bettor' : 'bettors'}
        </span>
        {pos && (
          <span style={{ marginLeft: 'auto', flex: 'none', height: 26, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 9999, background: 'var(--m3-inv-2)', fontWeight: 700 }}>
            {positionLabel(pos).replace('You · ', 'You: ')}
          </span>
        )}
      </div>
    </div>
  );
}
