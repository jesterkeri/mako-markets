import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CopyButton } from '@/app/me/MeParts';
import { AvatarFill } from '@/app/leaderboard/_components/AvatarFill';
import { TONE_FG } from '@/app/leaderboard/_components/props';
import { avatarColour, initialOf, signedUsdc2, usdc2 } from '@/lib/leaderboard/board-view';
import { getPublicProfile, isRegistered, type PublicProfile } from '@/lib/leaderboard/profile';
import { formatAddress } from '@/lib/user-display';

// Reads the ledger per request (cached a minute per address in getPublicProfile); never prerendered.
export const dynamic = 'force-dynamic';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const actorFrom = (raw: string): `0x${string}` | null => (ADDRESS_RE.test(raw) ? (raw.toLowerCase() as `0x${string}`) : null);

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const actor = actorFrom((await params).address);
  if (!actor || !(await isRegistered(actor))) return { title: 'Player · Mako Market Beta' };
  const p = await getPublicProfile(actor);
  return { title: `${p.displayName?.trim() || formatAddress(actor)} · Mako Market Beta` };
}

/// /u/[address] (13a, Joshua 2026-10-17): a Mako Market account's public profile, opened from the leaderboard, a pool's creator or
/// a comment's author. Name, photo, all-time profit rank, profit, bets, volume and the address with Copy.
export default async function PlayerPage({ params }: { params: Promise<{ address: string }> }) {
  const actor = actorFrom((await params).address);
  // Only a Mako Market account has a profile (Joshua 2026-10-17); any other address is not found, before the rank query.
  if (!actor || !(await isRegistered(actor))) notFound();
  const p = await getPublicProfile(actor);
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <Profile p={p} compact={false} />
      </div>
      <div className="mk-mob mk-m">
        <Profile p={p} compact />
      </div>
    </>
  );
}

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

function Profile({ p, compact }: { p: PublicProfile; compact: boolean }) {
  const name = p.displayName?.trim() || formatAddress(p.actor);
  const profit = signedUsdc2(BigInt(p.net));
  const avatar = compact ? 64 : 88;
  const stats = [
    { label: 'RANK', value: p.rank === null ? 'Unranked' : `#${p.rank}`, color: 'var(--mako-canvas-fg)' },
    { label: 'PROFIT', value: profit.text, color: TONE_FG[profit.tone] },
    { label: 'BETS', value: String(p.bets), color: 'var(--mako-canvas-fg)' },
    { label: 'VOLUME', value: usdc2(BigInt(p.staked)), color: 'var(--mako-canvas-fg)' },
  ];
  return (
    <section aria-label={`${name}'s profile`} style={{ padding: compact ? '20px 16px' : '32px 40px', maxWidth: 880, color: 'var(--mako-canvas-fg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 14 : 20, minWidth: 0 }}>
        <span aria-hidden="true" style={{ position: 'relative', overflow: 'hidden', flex: 'none', width: avatar, height: avatar, borderRadius: 9999, background: avatarColour(p.actor), color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: avatar * 0.42 }}>
          <AvatarFill initial={initialOf(p.displayName, p.actor)} avatarUrl={p.avatarUrl} />
        </span>
        <h1 style={{ ...display, fontSize: compact ? 26 : 36, letterSpacing: '-0.02em', margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{name}</h1>
      </div>

      <div style={{ marginTop: compact ? 16 : 20, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 12, boxShadow: 'inset 0 0 0 1px var(--line)' }}>
        <span style={{ ...mono, fontSize: compact ? 12 : 13, minWidth: 0, flex: '1 1 auto', overflowWrap: 'anywhere' }}>{p.actor}</span>
        {/* Its own "Copy" / "Copied" label: a server page cannot hand a function to a client button. */}
        <CopyButton text={p.actor} style={{ flex: 'none', height: 32, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', ...mono, fontSize: 12, fontWeight: 700 }} />
      </div>

      <dl style={{ marginTop: compact ? 16 : 24, display: 'grid', gridTemplateColumns: compact ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: compact ? 10 : 14 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ borderRadius: 14, background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', padding: compact ? 14 : 18, minWidth: 0 }}>
            <dt style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>{s.label}</dt>
            <dd style={{ ...display, margin: '6px 0 0', fontSize: compact ? 22 : 30, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: s.color, overflowWrap: 'anywhere' }}>{s.value}</dd>
          </div>
        ))}
      </dl>
      <p style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 14 }}>
        All time, pools. Profit is USDC won minus USDC staked; volume is USDC staked.{p.rank === null ? ' No bets yet.' : ''}
      </p>
    </section>
  );
}
