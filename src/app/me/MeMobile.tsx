'use client';

import Link from 'next/link';
import { useRef } from 'react';

import { ListStateMobile } from '@/components/ListState';
import { ICON } from '@/components/shell/icons';
import { openFeedback } from '@/lib/feedback-store';
import { tourHref } from '@/lib/tour';
import { CIRCLE_FAUCET_URL, FAUCET_NETWORK } from '@/lib/list-states';
import { estPayouts, ME_RANGES, resultLabel, signedUsdc, type MePosition } from '@/lib/me-stats';
import { CAT_STYLE, usdc2 } from '@/lib/pool-list';
import { formatAddress } from '@/lib/user-display';

import {
  AvatarFace,
  claimWhy,
  CopyButton,
  CREATE_HREF,
  display,
  MobileDialog,
  PENCIL,
  poolHref,
  ProfitChart,
  resultColour,
  SETTINGS_HREF,
  sideOf,
  statePill,
  Svg,
  type Loadable,
  type MeView,
} from './MeParts';
import { validateDisplayName } from './profile-rules';

// Me on mobile (11a), in the expressive look: identity, the balance tiles, test USDC, create and settings rows,
// Ready to claim, profit, badges, then the positions as cards. The shell draws the header and the tab bar.

const PLUS = 'M12 5.5v13M5.5 12h13';
const CHEVRON = 'M9 6l6 6-6 6';
const GEAR =
  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z';
/// How to play from its first step.
const TOUR_START = tourHref(0);
const UPLOAD = 'M12 16V5M7.5 9.5L12 5l4.5 4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3';

export function MeMobile(v: MeView) {
  return (
    <div>
      <Identity {...v} />
      <Tiles {...v} />
      <TestUsdc account={v.account} />
      <div style={{ padding: '10px 16px 0' }}>
        <RowLink href={CREATE_HREF} icon={<Svg d={PLUS} size={20} />} iconBg="var(--mako-signal)" title="Create a pool" sub={v.chain.status === 'ready' ? createdLine(v.chain.created) : 'Anyone can create one'} />
      </div>
      <div style={{ padding: '8px 16px 0' }}>
        <RowLink href="/wallet" icon={<Svg d={ICON.transfer} size={18} />} iconBg="var(--raise2)" title="Send and receive" sub="Send USDC or show your address" />
      </div>
      <div style={{ padding: '8px 16px 0' }}>
        <RowLink href={TOUR_START} icon={<Svg d={ICON.help} size={18} />} iconBg="var(--raise2)" title="How to play" sub="The 7-step intro to Mako Market" />
      </div>
      <div style={{ padding: '8px 16px 0' }}>
        <RowLink href={SETTINGS_HREF} icon={<Svg d={GEAR} size={18} />} iconBg="var(--raise2)" title="Settings" sub="Account, security, appearance, sign out" />
      </div>
      <div style={{ padding: '8px 16px 0' }}>
        <FeedbackRow />
      </div>
      {v.chain.status === 'ready' ? (
        <>
          {v.claimItems.length > 0 && <ReadyToClaim {...v} />}
          <Profit {...v} />
          <Badges />
          <Positions {...v} />
        </>
      ) : (
        <div style={{ paddingTop: 2 }}>
          <ListStateMobile kind="me" state={v.chain.status} onRetry={v.retry} explorerHref={v.explorerHref} />
        </div>
      )}
      {v.editing && <NameDialog {...v} />}
      {v.photoOpen && <PhotoDialog {...v} />}
    </div>
  );
}

function createdLine(n: number): string {
  return n === 0 ? 'Anyone can create one' : `You’ve created ${n} ${n === 1 ? 'pool' : 'pools'}`;
}

function Identity(v: MeView) {
  const { user, account, label, initial, name, emailAccount } = v;
  const round: React.CSSProperties = { flex: 'none', width: 44, height: 44, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mako-canvas-fg)' };
  return (
    <div style={{ padding: '6px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          type="button"
          onClick={() => v.setPhotoOpen(true)}
          aria-label="Change profile picture"
          className="m3-press"
          style={{ position: 'relative', flex: 'none', width: 72, height: 72, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 30, overflow: 'visible' }}
        >
          <AvatarFace url={user.avatarUrl} initial={initial} />
          <span style={{ position: 'absolute', right: -2, bottom: -2, width: 28, height: 28, borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', boxShadow: '0 0 0 3px var(--mako-canvas)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Svg d={PENCIL} size={13} />
          </span>
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, ...display, fontSize: 28, lineHeight: 1.05, letterSpacing: '-0.03em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</h1>
          <CopyButton text={account} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 14, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
            {(copied) => (
              <>
                {formatAddress(account)} · <span style={{ fontWeight: 700, color: 'var(--mako-canvas-fg)' }}>{copied ? 'Copied' : 'Copy'}</span>
              </>
            )}
          </CopyButton>
        </div>
        <button type="button" onClick={v.startEdit} aria-label={name ? 'Edit name' : 'Set a name'} className="m3-press" style={round}>
          <Svg d={PENCIL} size={18} />
        </button>
      </div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 10 }}>{emailAccount ? 'Signed in with email · gas sponsored' : 'Signed in with a wallet · you pay gas in MON'}</div>
    </div>
  );
}

function Figure({ value, size, colour }: { value: Loadable<bigint>; size: number; colour?: string }) {
  if (value.status === 'loading') return <div aria-label="Loading" style={{ width: '70%', height: size * 0.8, borderRadius: 8, marginTop: 6, background: 'color-mix(in srgb, currentColor 16%, transparent)' }} />;
  if (value.status === 'error') return <div style={{ ...display, fontSize: Math.min(size, 22), marginTop: 6, opacity: 0.7 }}>Unavailable</div>;
  return <div style={{ ...display, fontSize: size, lineHeight: 1, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: colour }}>{usdc2(value.value)}</div>;
}

function Tiles(v: MeView) {
  const c = v.chain;
  const inPlay: Loadable<bigint> = c.status === 'ready' ? { status: 'ready', value: c.stats.inPlay } : c;
  const won: Loadable<bigint> = c.status === 'ready' ? { status: 'ready', value: c.stats.wonAllTime } : c;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 10, padding: '14px 16px 0' }}>
      <div style={{ position: 'relative', gridRow: 'span 2', borderRadius: '32px 32px 32px 12px', background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', padding: 18 }}>
        <a
          href={CIRCLE_FAUCET_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Get test USDC from Circle’s faucet (choose ${FAUCET_NETWORK})`}
          className="m3-press"
          style={{ position: 'absolute', top: 14, right: 14, width: 36, height: 36, borderRadius: 9999, background: '#000', color: 'var(--mako-signal)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Svg d={PLUS} size={18} />
        </a>
        <div style={{ fontSize: 14, fontWeight: 700, opacity: 0.7 }}>Balance</div>
        <div style={{ marginTop: 40 }}>
          <Figure value={v.balance} size={44} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>USDC</div>
      </div>
      <div style={{ borderRadius: 24, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.65 }}>In play</div>
        <div style={{ marginTop: 4 }}>
          <Figure value={inPlay} size={24} />
        </div>
      </div>
      <div style={{ borderRadius: 24, background: 'var(--raise)', padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dim)' }}>Won all time</div>
        <div style={{ marginTop: 4 }}>
          <Figure value={won} size={24} />
        </div>
      </div>
    </div>
  );
}

/// Test USDC from Circle's faucet, with the address it asks for and a Copy beside it.
function TestUsdc({ account }: { account: `0x${string}` }) {
  return (
    <div style={{ padding: '10px 16px 0' }}>
      <div data-tour-anchor="test-usdc" style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 28, background: 'var(--mako-violet)', color: '#000', boxShadow: 'var(--edge)', padding: '14px 14px 14px 18px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Get test USDC</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(0,0,0,0.75)', marginTop: 2 }}>In the faucet, choose {FAUCET_NETWORK}</div>
          <CopyButton text={account} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 13, fontWeight: 600, color: 'rgba(0,0,0,0.75)', fontVariantNumeric: 'tabular-nums' }}>
            {(copied) => (
              <>
                {formatAddress(account)} · <span style={{ fontWeight: 800, color: '#000' }}>{copied ? 'Copied' : 'Copy'}</span>
              </>
            )}
          </CopyButton>
        </div>
        <a
          href={CIRCLE_FAUCET_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-tour-point="test-usdc"
          className="m3-press m3-scale96"
          style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center', padding: '0 16px', borderRadius: 9999, background: '#000', color: '#fff', fontSize: 14, fontWeight: 800, textDecoration: 'none' }}
        >
          Circle faucet ↗
        </a>
      </div>
    </div>
  );
}

const ROW: React.CSSProperties = { width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 12, borderRadius: 28, background: 'var(--raise)', padding: '10px 14px 10px 10px', color: 'inherit', textDecoration: 'none', textAlign: 'left' };

function RowInner({ icon, iconBg, title, sub }: { icon: React.ReactNode; iconBg: string; title: string; sub: string }) {
  return (
    <>
      <span style={{ flex: 'none', width: 52, height: 52, borderRadius: 9999, background: iconBg, color: iconBg === 'var(--mako-signal)' ? '#000' : 'var(--mako-canvas-fg)', boxShadow: iconBg === 'var(--mako-signal)' ? 'var(--edge)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 800 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 13, color: 'var(--dim)', marginTop: 2 }}>{sub}</span>
      </span>
      <Svg d={CHEVRON} size={18} />
    </>
  );
}

function RowLink({ href, ...row }: { href: string; icon: React.ReactNode; iconBg: string; title: string; sub: string }) {
  return (
    <Link href={href} className="m3-press" style={ROW}>
      <RowInner {...row} />
    </Link>
  );
}

/// Opens the feedback sheet. Also shown under the signed-out Me card, since a person who cannot sign in is the one
/// whose report matters most.
export function FeedbackRow() {
  return (
    <button type="button" onClick={openFeedback} className="m3-press" style={ROW}>
      <RowInner icon={<Svg d={ICON.feedback} size={18} />} iconBg="var(--raise2)" title="Feedback" sub="Report a problem or an idea" />
    </button>
  );
}

function ReadyToClaim(v: MeView) {
  return (
    <div style={{ padding: '12px 12px 0' }}>
      <div style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '18px 18px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...display, fontSize: 22 }}>Ready to claim</span>
          <span style={{ minWidth: 28, height: 28, padding: '0 8px', boxSizing: 'border-box', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 }}>{v.pendingClaims}</span>
        </div>
        {v.claimItems.map(({ p, landed }) => {
          const amount = usdc2(p.claim ?? 0n);
          const refund = p.state === 'refunded';
          return (
            <div key={p.market.id.toString()} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', boxShadow: 'inset 0 -1px 0 var(--m3-inv-2)' }}>
              <span aria-hidden="true" style={{ flex: 'none', width: 40, height: 40, borderRadius: 9999, background: refund ? 'var(--mako-cyan)' : 'var(--mako-teal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>
                {refund ? 'RF' : CAT_STYLE[p.cat].abbr}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Link href={poolHref(p.market.id)} style={{ display: 'block', fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
                  {p.market.question}
                </Link>
                <div style={{ fontSize: 13, opacity: 0.65 }}>{claimWhy(p, v.labelsOf(p))}</div>
              </div>
              {landed ? (
                <span style={{ flex: 'none', fontSize: 13, fontWeight: 800, opacity: 0.7, whiteSpace: 'nowrap' }}>✓ Claimed</span>
              ) : (
                <button
                  type="button"
                  onClick={() => v.openClaim(p)}
                  className="m3-press m3-scale96"
                  style={{ flex: 'none', height: 38, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
                >
                  Claim {amount} USDC
                </button>
              )}
            </div>
          );
        })}
        {v.pendingClaims === 0 && <div style={{ marginTop: 12, fontSize: 14, fontWeight: 700 }}>✓ Everything claimed. It’s in your balance.</div>}
      </div>
    </div>
  );
}

function Profit(v: MeView) {
  const s = v.series!;
  const range = ME_RANGES.find((r) => r.key === v.range)!;
  return (
    <div style={{ padding: '12px 12px 0' }}>
      <div style={{ borderRadius: 28, background: 'var(--raise)', padding: '16px 16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, opacity: 0.7 }}>Profit · {range.long}</span>
          <div role="group" aria-label="Range" style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9999, background: 'var(--raise2)' }}>
            {ME_RANGES.map((r) => {
              const on = r.key === v.range;
              return (
                <button key={r.key} type="button" onClick={() => v.setRange(r.key)} aria-pressed={on} className="m3-press" style={{ height: 30, padding: '0 12px', borderRadius: 9999, background: on ? 'var(--m3-inv)' : 'transparent', color: on ? 'var(--m3-inv-fg)' : 'var(--mako-canvas-fg)', fontSize: 13, fontWeight: 800 }}>
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ ...display, fontSize: 38, letterSpacing: '-0.03em', marginTop: 6, fontVariantNumeric: 'tabular-nums', color: s.total < 0n ? 'var(--mako-red)' : 'var(--up-text)' }}>
          {signedUsdc(s.total)} <span style={{ fontSize: 16 }}>USDC</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>
          {s.pools} {s.pools === 1 ? 'pool' : 'pools'} · {s.won} won · <span style={{ color: 'var(--mako-red)' }}>{s.lost} lost</span>
          {s.refunded > 0 && ` · ${s.refunded} refunded`}
        </div>
        <div style={{ marginTop: 10 }}>
          <ProfitChart points={s.points} height={110} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8 }}>{s.pools === 0 ? 'No settled pools in this range.' : 'One step per settled pool, by pool close.'}</div>
      </div>
    </div>
  );
}

/// No badge engine exists yet: the heading stays, nothing is shown as earned or ranked.
function Badges() {
  return (
    <div style={{ padding: '10px 12px 0' }}>
      <div style={{ borderRadius: 28, background: 'var(--raise)', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...display, fontSize: 20 }}>Badges</span>
          <span style={{ height: 24, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 9999, background: 'var(--raise2)', fontSize: 12, fontWeight: 800 }}>Coming soon</span>
        </div>
        <div style={{ fontSize: 14, color: 'var(--dim)', marginTop: 8 }}>Badges aren’t live yet, so there is nothing to earn here for now.</div>
      </div>
    </div>
  );
}

function Positions(v: MeView) {
  if (v.chain.status !== 'ready') return null;
  const { active, settled } = v.chain.stats;
  const rows = v.tab === 'active' ? active : settled;
  return (
    <>
      <div style={{ height: 18 }} />
      <div role="group" aria-label="Positions" style={{ display: 'flex', gap: 4, padding: 4, margin: '0 16px', borderRadius: 9999, background: 'var(--raise)' }}>
        {(
          [
            ['active', 'Active', active.length],
            ['settled', 'Settled', settled.length],
          ] as const
        ).map(([k, label, n]) => {
          const on = k === v.tab;
          return (
            <button key={k} type="button" onClick={() => v.setTab(k)} aria-pressed={on} className="m3-press" style={{ flex: 1, height: 44, borderRadius: 9999, background: on ? 'var(--m3-inv)' : 'transparent', color: on ? 'var(--m3-inv-fg)' : 'var(--mako-canvas-fg)', boxShadow: on ? 'var(--edge)' : 'none', fontSize: 15, fontWeight: 800, transition: 'background-color 250ms cubic-bezier(0.2,0,0,1)' }}>
              {label} <span style={{ opacity: 0.6 }}>{n}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 12px 0' }}>
        {rows.map((p) => (
          <PositionCard key={p.market.id.toString()} p={p} v={v} />
        ))}
        {rows.length === 0 && (
          <div style={{ borderRadius: 28, background: 'var(--raise)', padding: '26px 20px', textAlign: 'center' }}>
            <div style={{ ...display, fontSize: 20 }}>{v.tab === 'active' ? 'No active positions' : 'No settled positions yet'}</div>
            <div style={{ fontSize: 14, color: 'var(--dim)', marginTop: 6 }}>{v.tab === 'active' ? 'Bets on pools that haven’t settled show up here.' : 'Results land here once your bets settle.'}</div>
            {v.tab === 'active' && (
              <Link href="/pools" className="m3-press m3-scale96" style={{ display: 'inline-flex', alignItems: 'center', height: 44, padding: '0 20px', marginTop: 14, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 15, fontWeight: 800, textDecoration: 'none' }}>
                Browse pools
              </Link>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function PositionCard({ p, v }: { p: MePosition; v: MeView }) {
  const labels = v.labelsOf(p);
  const side = sideOf(p, labels);
  const pill = statePill(p.state);
  const pays = estPayouts(p.market, p.bet);
  const chip: React.CSSProperties = { height: 26, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 9999, color: '#000', boxShadow: 'var(--edge)', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '45%' };
  return (
    <Link href={poolHref(p.market.id)} className="m3-press" style={{ display: 'block', borderRadius: 26, background: 'var(--raise)', padding: '14px 16px', color: 'inherit', textDecoration: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...chip, background: side.bg, color: side.fg }}>{side.text}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dim)' }}>Pool</span>
        <span style={{ ...chip, marginLeft: 'auto', background: pill.bg }}>{pill.label}</span>
      </div>
      <div style={{ ...display, fontSize: 18, lineHeight: 1.22, marginTop: 10 }}>{p.market.question}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 10, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--dim)' }}>Stake</span> <span style={{ fontWeight: 800 }}>{usdc2(p.stake)}</span>
        </span>
        {p.settlement ? (
          <span style={{ fontWeight: 800, color: resultColour(p), textAlign: 'right' }}>{resultLabel(p.settlement, p.stake)} USDC</span>
        ) : (
          <span style={{ textAlign: 'right', minWidth: 0 }}>
            <span style={{ color: 'var(--dim)' }}>Est. payout</span>{' '}
            <span style={{ fontWeight: 800 }}>{pays.map((e) => (pays.length > 1 ? `${e.side === 'yes' ? labels.yes : labels.no} ${usdc2(e.payout)}` : usdc2(e.payout))).join(' · ')}</span>
          </span>
        )}
      </div>
    </Link>
  );
}

function NameDialog(v: MeView) {
  const { edit, draft, name } = v;
  const invalid = validateDisplayName(draft);
  const canSave = !invalid && draft.trim() !== (name ?? '') && !edit.nameBusy;
  const hint = invalid ?? (edit.nameError || 'Looks good. This is how you show up in comments and the leaderboard.');
  const hintIsError = invalid !== null || edit.nameError !== '';
  return (
    <MobileDialog label="Display name" onClose={v.cancelEdit}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) v.saveDraft();
        }}
      >
        <div style={{ ...display, fontSize: 22 }}>Display name</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, height: 56, padding: '0 16px', borderRadius: 20, background: 'var(--m3-inv-2)' }}>
          <input
            value={draft}
            onChange={(e) => v.setDraft(e.target.value)}
            aria-label="Display name"
            maxLength={32}
            autoFocus
            style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit', fontFamily: 'var(--mako-font-sans)', fontSize: 18, fontWeight: 700 }}
          />
        </div>
        <div role={hintIsError ? 'alert' : undefined} style={{ fontSize: 13, fontWeight: 600, marginTop: 8, color: hintIsError ? 'var(--mako-red)' : 'inherit' }}>
          {hint}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={v.cancelEdit} className="m3-press" style={{ height: 52, padding: '0 22px', borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 16, fontWeight: 800 }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="m3-press"
            style={{ flex: 1, height: 52, borderRadius: 9999, background: canSave ? 'var(--mako-signal)' : 'var(--m3-inv-2)', color: canSave ? '#000' : 'inherit', opacity: canSave ? 1 : 0.6, boxShadow: canSave ? 'var(--edge)' : 'none', fontSize: 16, fontWeight: 800 }}
          >
            {edit.nameBusy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </MobileDialog>
  );
}

function PhotoDialog(v: MeView) {
  const { edit, user } = v;
  const file = useRef<HTMLInputElement>(null);
  const busy = edit.photo !== 'idle';
  const close = () => v.setPhotoOpen(false);
  return (
    <MobileDialog label="Profile picture" onClose={close}>
      <div style={{ ...display, fontSize: 22 }}>Profile picture</div>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void edit.uploadPhoto(f);
        }}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        onClick={() => file.current?.click()}
        disabled={busy}
        className="m3-press"
        style={{ width: '100%', height: 52, marginTop: 14, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: busy ? 0.6 : 1 }}
      >
        <Svg d={UPLOAD} size={18} />
        {edit.photo === 'uploading' ? 'Uploading…' : 'Upload a photo'}
      </button>
      {user.avatarUrl && (
        <button type="button" onClick={() => void edit.removePhoto()} disabled={busy} className="m3-press" style={{ width: '100%', height: 48, marginTop: 8, borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 15, fontWeight: 800, opacity: busy ? 0.6 : 1 }}>
          {edit.photo === 'removing' ? 'Removing…' : 'Remove photo'}
        </button>
      )}
      <div style={{ fontSize: 13, opacity: 0.65, marginTop: 10 }}>PNG, JPG or WEBP, up to 4 MB.</div>
      {edit.photoError && (
        <div role="alert" style={{ fontSize: 13, fontWeight: 700, marginTop: 8, color: 'var(--mako-red)' }}>
          {edit.photoError}
        </div>
      )}
      <button type="button" onClick={close} className="m3-press" style={{ width: '100%', height: 52, marginTop: 16, borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 16, fontWeight: 800 }}>
        Done
      </button>
    </MobileDialog>
  );
}

