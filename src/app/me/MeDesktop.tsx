'use client';

import Link from 'next/link';
import { useRef } from 'react';

import { ListStateDesktop } from '@/components/ListState';
import { hasPnlCard, PnlShareButton } from '@/components/PnlShareSheet';
import { CIRCLE_FAUCET_URL, FAUCET_NETWORK } from '@/lib/list-states';
import { estPayouts, ME_RANGES, positionMeta, resultLabel, signedUsdc, type MePosition } from '@/lib/me-stats';
import { usdc2 } from '@/lib/pool-list';
import { FlashValue } from '@/lib/use-flash';
import { tourHref } from '@/lib/tour';
import { formatAddress } from '@/lib/user-display';

import {
  AvatarFace,
  BAR,
  claimAmount,
  claimHref,
  claimKey,
  claimReason,
  claimTitle,
  CopyButton,
  CREATE_HREF,
  display,
  mono,
  PENCIL,
  poolHref,
  ProfitChart,
  rangeStart,
  resultColour,
  sideOf,
  statePill,
  Svg,
  type Loadable,
  type MeView,
} from './MeParts';
import { CreatorEarningsSection } from './CreatorEarningsSection';
import { ReferralCard } from './ReferralCard';
import { CREATOR_EARNINGS_ANCHOR, creatorTotalsLabel, useCreatorTotals } from './use-creator-totals';
import { NAME_RESERVED, NAME_TAKEN, validateDisplayName } from './profile-rules';
import { useNameCheck } from './use-name-check';

// Me on desktop (11a), in the terminal look, in two columns (Joshua 2026-10-24): identity, the totals, profit and
// positions on the left; test USDC, invite, badges, Ready to claim and creator earnings in a sticky right panel.

/// How to play from its first step.
const TOUR_START = tourHref(0);
// The last column holds Share on a position with a card (bet placed while unsettled, or a win or loss), else the arrow.
// Tight fixed columns: the table sits in the left column beside the account panel (Joshua 2026-10-24).
const COLS = 'minmax(0,1fr) 64px 96px 130px 100px 64px';

export function MeDesktop(v: MeView) {
  return (
    // Two columns (Joshua 2026-10-24): the profile, totals, profit and positions on the left; every account tool on the
    // right, in one panel that sticks and scrolls on its own.
    // The panel narrows on smaller desktops so the positions table keeps room for the market name.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) clamp(340px, 28vw, 380px)', gap: 32, paddingBottom: 28 }}>
      <div style={{ minWidth: 0 }}>
        <Identity {...v} />
        {v.photoOpen && <PhotoPanel {...v} />}
        <Totals {...v} />
        {v.chain.status === 'ready' ? (
          <>
            <div style={{ marginTop: 26, padding: '0 4px' }}>
              <Profit {...v} />
            </div>
            <div style={{ marginTop: 26, padding: '0 4px' }}>
              <Positions {...v} />
            </div>
          </>
        ) : (
          <div style={{ marginTop: 26 }}>
            <ListStateDesktop kind="me" state={v.chain.status} onRetry={v.retry} explorerHref={v.explorerHref} />
          </div>
        )}
      </div>
      {/* A named, focusable region, so a keyboard can scroll it (Codex ME_ASIDE R1 F2). */}
      <aside
        role="region"
        aria-label="Account tools"
        tabIndex={0}
        style={{ position: 'sticky', top: 20, alignSelf: 'start', maxHeight: 'calc(100dvh - 40px)', overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin', display: 'flex', flexDirection: 'column', gap: 26, padding: '22px 4px 4px' }}
      >
        <TestUsdc account={v.account} />
        <ReferralCard account={v.account} variant="desktop" />
        <Badges />
        {v.chain.status === 'ready' && (
          <div>
            <ReadyToClaim {...v} />
            <Creator created={v.chain.created} />
          </div>
        )}
        {/* The creator list reads only the pools, so it stays when the stake or rounds read failed: the Creator
            earnings card in the totals row always has its list to lead to (adversary on 03bbb76). */}
        <CreatorEarningsSection user={v.user} account={v.account} variant="desktop" />
      </aside>
    </div>
  );
}

function Identity(v: MeView) {
  const { user, account, name, label, initial, emailAccount, editing, draft, edit } = v;
  const invalid = editing ? validateDisplayName(draft) : null;
  const unchanged = draft.trim() === (name ?? '');
  const check = useNameCheck(draft, name, editing, account);
  const canSave = !invalid && !unchanged && !edit.nameBusy && check !== 'taken' && check !== 'reserved';
  const hint =
    invalid ??
    (check === 'taken' ? NAME_TAKEN : check === 'reserved' ? NAME_RESERVED : edit.nameError || (check === 'checking' ? 'Checking the name...' : 'Looks good. This is how you show up in comments and the leaderboard.'));
  const hintIsError = invalid !== null || check === 'taken' || check === 'reserved' || edit.nameError !== '';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 22, padding: '22px 4px 24px' }}>
      <button
        type="button"
        onClick={() => v.setPhotoOpen(!v.photoOpen)}
        aria-label="Change profile picture"
        aria-expanded={v.photoOpen}
        className="mk-press97"
        style={{ position: 'relative', flex: 'none', width: 96, height: 96, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 40 }}
      >
        <AvatarFace url={user.avatarUrl} initial={initial} />
        <span style={{ position: 'absolute', right: -2, bottom: -2, width: 32, height: 32, borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', boxShadow: '0 0 0 3px var(--mako-canvas)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Svg d={PENCIL} size={15} />
        </span>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!editing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <h1 style={{ margin: 0, ...display, fontSize: 56, lineHeight: 1, letterSpacing: '-0.04em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{label}</h1>
            <button type="button" onClick={v.startEdit} style={{ flex: 'none', height: 34, padding: '0 14px', borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)', ...mono, fontSize: 12, fontWeight: 700 }}>
              {name ? 'EDIT' : 'SET NAME'}
            </button>
            <Link href={TOUR_START} style={{ flex: 'none', height: 34, padding: '0 14px', borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)', ...mono, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, color: 'inherit', textDecoration: 'none' }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--mako-signal)' }} />
              HOW TO PLAY
            </Link>
          </div>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (canSave) v.saveDraft();
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 560 }}
            >
              <input
                value={draft}
                onChange={(e) => v.setDraft(e.target.value)}
                aria-label="Display name"
                maxLength={32}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') v.cancelEdit();
                }}
                style={{ flex: 1, minWidth: 0, height: 54, padding: '0 16px', border: 0, outline: 0, borderRadius: 12, background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', color: 'var(--mako-canvas-fg)', ...display, fontSize: 28 }}
              />
              <button
                type="submit"
                disabled={!canSave}
                style={{ flex: 'none', height: 48, padding: '0 20px', borderRadius: 9999, background: canSave ? 'var(--mako-signal)' : 'var(--raise2)', color: canSave ? '#000' : 'var(--dim)', boxShadow: canSave ? 'var(--edge)' : 'none', ...display, fontSize: 15, cursor: canSave ? 'pointer' : 'not-allowed' }}
              >
                {edit.nameBusy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={v.cancelEdit} style={{ flex: 'none', height: 48, padding: '0 16px', borderRadius: 9999, background: 'var(--raise2)', ...display, fontSize: 15 }}>
                Cancel
              </button>
            </form>
            <div role={hintIsError ? 'alert' : undefined} style={{ ...mono, fontSize: 12, marginTop: 8, color: hintIsError ? 'var(--mako-red)' : 'var(--dim)' }}>
              {hint}
            </div>
          </>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, ...mono, fontSize: 13, color: 'var(--dim)' }}>
          {formatAddress(account)}
          <CopyButton text={account} style={{ height: 26, padding: '0 10px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700 }} />
          <span>· {emailAccount ? 'signed in with email · gas sponsored' : 'signed in with a wallet · you pay gas in MON'}</span>
        </div>
      </div>
    </div>
  );
}

/// Test USDC comes from Circle's faucet, which asks for the account's address: the address and Copy sit beside it.
function TestUsdc({ account }: { account: `0x${string}` }) {
  return (
    <div data-tour-anchor="test-usdc" style={{ padding: '16px 18px', borderRadius: 14, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...display, fontSize: 20 }}>Test USDC</span>
        <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>MONAD TESTNET</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 4 }}>Free test USDC to try Mako Market comes from Circle’s faucet. Choose {FAUCET_NETWORK} there, then paste your address.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <a
          href={CIRCLE_FAUCET_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mk-press97"
          style={{ flex: 1, height: 48, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
        >
          Get test USDC ↗
        </a>
        <CopyButton text={account} className="mk-press97" style={{ flex: 'none', height: 48, padding: '0 16px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', ...mono, fontSize: 12, fontWeight: 700 }}>
          {(copied) => (copied ? 'Copied' : `Copy ${formatAddress(account)}`)}
        </CopyButton>
      </div>
    </div>
  );
}

function PhotoPanel(v: MeView) {
  const { edit, user } = v;
  const file = useRef<HTMLInputElement>(null);
  const busy = edit.photo !== 'idle';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '-8px 4px 20px', padding: '12px 14px', borderRadius: 14, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
      <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginRight: 6 }}>PROFILE PICTURE</span>
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
        className="mk-press97"
        style={{ height: 40, padding: '0 16px', borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', ...display, fontSize: 14, opacity: busy ? 0.6 : 1 }}
      >
        {edit.photo === 'uploading' ? 'Uploading…' : 'Upload photo'}
      </button>
      {user.avatarUrl && (
        <button type="button" onClick={() => void edit.removePhoto()} disabled={busy} style={{ height: 40, padding: '0 16px', borderRadius: 9999, background: 'var(--raise2)', ...display, fontSize: 14, opacity: busy ? 0.6 : 1 }}>
          {edit.photo === 'removing' ? 'Removing…' : 'Remove photo'}
        </button>
      )}
      <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>PNG, JPG OR WEBP · MAX 4 MB</span>
      {edit.photoError && (
        <span role="alert" style={{ fontSize: 13, color: 'var(--mako-red)' }}>
          {edit.photoError}
        </span>
      )}
      <button type="button" onClick={() => v.setPhotoOpen(false)} style={{ marginLeft: 'auto', ...mono, fontSize: 12, fontWeight: 700 }}>
        DONE
      </button>
    </div>
  );
}

/// A total on the page canvas: when a re-read changes it, it flashes up (YES text) or down (NO text) (motion pass 7).
export function Amount({ value, colour, suffix = ' USDC' }: { value: Loadable<bigint>; colour?: string; suffix?: string }) {
  const big: React.CSSProperties = { ...display, fontSize: 30, letterSpacing: '-0.02em', marginTop: 4, fontVariantNumeric: 'tabular-nums' };
  if (value.status === 'loading') return <div aria-label="Loading" style={{ width: 150, height: 30, borderRadius: 8, marginTop: 6, background: BAR }} />;
  if (value.status === 'error') return <div style={{ ...big, fontSize: 22, marginTop: 8, color: 'var(--dim)' }}>Unavailable</div>;
  return (
    <div style={{ ...big, color: colour ?? 'var(--mako-canvas-fg)' }}>
      <FlashValue value={value.value} text={`${usdc2(value.value)}${suffix}`} kind="direction" />
    </div>
  );
}

function Totals(v: MeView) {
  const c = v.chain;
  const from = (pick: (s: Extract<typeof c, { status: 'ready' }>['stats']) => bigint): Loadable<bigint> => (c.status === 'ready' ? { status: 'ready', value: pick(c.stats) } : c);
  const cells: [string, Loadable<bigint>, string?][] = [
    ['BALANCE', v.balance],
    ['IN PLAY', from((s) => s.inPlay)],
    ['READY TO CLAIM', v.ready, 'var(--up-text)'],
  ];
  // Each cell draws its own top line, so a wrapped second row is ruled too.
  const cell: React.CSSProperties = { padding: '14px 18px', boxShadow: 'inset 1px 0 0 var(--line), inset 0 1px 0 var(--line)' };
  return (
    // Three a row in the left column: five side by side do not fit a figure like 22.83 USDC on one line.
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
      {cells.map(([label, value, colour]) => (
        <div key={label} style={cell}>
          <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>{label}</div>
          <Amount value={value} colour={colour} />
        </div>
      ))}
      <CreatorTotalsCell account={v.account} style={cell} />
      <div style={cell}>
        <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>WON ALL TIME</div>
        <Amount value={from((s) => s.wonAllTime)} />
      </div>
    </div>
  );
}

/// Creator earnings beside the other totals: unclaimed fees as the figure, what was already collected under it. It
/// leads to the Creator earnings list, or to creating a first pool when there is none.
function CreatorTotalsCell({ account, style }: { account: string; style: React.CSSProperties }) {
  const t = useCreatorTotals(account);
  const unclaimed: Loadable<bigint> = t.status === 'ready' ? { status: 'ready', value: t.value.unclaimed } : t;
  const hasPools = t.status === 'ready' && t.value.pools > 0;
  const sub =
    t.status !== 'ready' ? null : hasPools ? `${usdc2(t.value.claimed)} USDC CLAIMED` : 'CREATE A POOL TO EARN';
  const body = (
    <>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>CREATOR EARNINGS</div>
      <Amount value={unclaimed} colour={t.status === 'ready' && t.value.unclaimed > 0n ? 'var(--up-text)' : undefined} />
      {sub && <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>{sub}</div>}
    </>
  );
  const linkStyle: React.CSSProperties = { ...style, display: 'block', color: 'inherit', textDecoration: 'none' };
  if (hasPools) {
    return (
      <a href={`#${CREATOR_EARNINGS_ANCHOR.desktop}`} aria-label={creatorTotalsLabel(t.value)} className="mk-press97" style={linkStyle}>
        {body}
      </a>
    );
  }
  if (t.status === 'ready') {
    return (
      <Link href={CREATE_HREF} aria-label={creatorTotalsLabel(t.value)} className="mk-press97" style={linkStyle}>
        {body}
      </Link>
    );
  }
  return <div style={style}>{body}</div>;
}

function Profit(v: MeView) {
  const s = v.series!;
  const range = ME_RANGES.find((r) => r.key === v.range)!;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '.06em' }}>PROFIT · {range.long.toUpperCase()}</span>
        <div role="group" aria-label="Range" style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9999, background: 'var(--raise)' }}>
          {ME_RANGES.map((r) => {
            const on = r.key === v.range;
            return (
              <button key={r.key} type="button" onClick={() => v.setRange(r.key)} aria-pressed={on} style={{ height: 28, padding: '0 12px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'transparent', color: on ? 'var(--mako-canvas)' : 'var(--dim)', ...mono, fontSize: 11, fontWeight: 700 }}>
                {r.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 6 }}>
        <span style={{ ...display, fontSize: 40, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: s.total < 0n ? 'var(--mako-red)' : 'var(--up-text)' }}>{signedUsdc(s.total)}</span>
        <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>
          USDC · {s.pools} {s.pools === 1 ? 'POOL' : 'POOLS'} · {s.won} WON · <span style={{ color: 'var(--mako-red)' }}>{s.lost} LOST</span>
          {s.refunded > 0 && ` · ${s.refunded} REFUNDED`}
        </span>
      </div>
      <div style={{ marginTop: 14, paddingBottom: 6, boxShadow: 'inset 0 -1px 0 var(--line)' }}>
        <ProfitChart points={s.points} height={150} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 8 }}>
        <span>{rangeStart(v.range, s.firstClose)}</span>
        <span>{s.pools === 0 ? 'NO SETTLED POOLS IN THIS RANGE' : 'ONE STEP PER SETTLED POOL, BY POOL CLOSE'}</span>
        <span>TODAY</span>
      </div>
    </div>
  );
}

/// No badge engine exists yet: the heading stays, nothing is shown as earned or ranked.
function Badges() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 10, boxShadow: 'inset 0 -1px 0 var(--line)' }}>
        <span style={{ ...display, fontSize: 22, letterSpacing: '-0.02em' }}>Badges</span>
        <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>COMING SOON</span>
      </div>
      <div style={{ padding: '14px 0', fontSize: 14, lineHeight: 1.5, color: 'var(--dim)' }}>Badges aren’t live yet, so there is nothing to earn here for now.</div>
    </div>
  );
}

function Positions(v: MeView) {
  if (v.chain.status !== 'ready') return null;
  const { active, settled } = v.chain.stats;
  const rows = v.tab === 'active' ? active : settled;
  return (
    <div>
      <div role="group" aria-label="Positions" style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 12 }}>
        {(
          [
            ['active', 'Active', active.length],
            ['settled', 'Settled', settled.length],
          ] as const
        ).map(([k, label, n]) => {
          const on = k === v.tab;
          return (
            <button key={k} type="button" onClick={() => v.setTab(k)} aria-pressed={on} className="mk-press96" style={{ height: 34, padding: '0 16px', borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'var(--raise)', color: on ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', ...mono, fontSize: 12, fontWeight: 700 }}>
              {label} <span style={{ opacity: 0.6 }}>{n}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '10px 0', boxShadow: 'inset 0 1px 0 var(--line)', ...mono, fontSize: 10, color: 'var(--dim)' }}>
        <span>MARKET</span>
        <span>SIDE</span>
        <span style={{ textAlign: 'right' }}>STAKE</span>
        <span style={{ textAlign: 'right' }}>{v.tab === 'active' ? 'EST. PAYOUT' : 'RESULT'}</span>
        <span>STATE</span>
        <span />
      </div>
      {rows.map((p) => (
        <PositionRow key={p.market.id.toString()} p={p} v={v} />
      ))}
      {rows.length === 0 && (
        <div style={{ padding: '40px 0', boxShadow: 'inset 0 1px 0 var(--line)', textAlign: 'center' }}>
          <div style={{ ...display, fontSize: 22 }}>{v.tab === 'active' ? 'No active positions' : 'No settled positions yet'}</div>
          <div style={{ fontSize: 14, color: 'var(--dim)', marginTop: 6 }}>
            {v.tab === 'active' ? 'Bets on pools that haven’t settled show up here.' : 'Results land here once your pools settle.'}
          </div>
          {v.tab === 'active' && (
            <Link href="/pools" className="mk-press96" style={{ display: 'inline-flex', alignItems: 'center', height: 40, padding: '0 18px', marginTop: 16, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 14, textDecoration: 'none' }}>
              Browse pools
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function PositionRow({ p, v }: { p: MePosition; v: MeView }) {
  const labels = v.labelsOf(p);
  const side = sideOf(p, labels);
  const pill = statePill(p.state);
  const pays = estPayouts(p.market, p.bet);
  const pillStyle: React.CSSProperties = { justifySelf: 'start', maxWidth: '100%', height: 24, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 9999, color: '#000', boxShadow: 'var(--edge)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  return (
    <div className="mk-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, alignItems: 'center', padding: '15px 0', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div style={{ minWidth: 0 }}>
        <Link href={poolHref(p.market.id)} className="mk-rowlink" style={{ display: 'block', ...display, fontSize: 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
          {p.market.question}
        </Link>
        <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>Pool · {v.now === null ? '' : positionMeta(p, v.now)}</div>
      </div>
      <span style={{ ...pillStyle, background: side.bg, color: side.fg, fontSize: 11, fontWeight: 800 }}>{side.text}</span>
      <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700 }}>
        <FlashValue value={p.stake} text={usdc2(p.stake)} kind="direction" />
      </span>
      {p.settlement ? (
        <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700, color: resultColour(p) }}>{resultLabel(p.settlement, p.stake)}</span>
      ) : pays.length === 1 ? (
        <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700 }}>
          <FlashValue value={pays[0].payout} text={usdc2(pays[0].payout)} kind="direction" /> USDC
        </span>
      ) : (
        <span style={{ textAlign: 'right', ...mono, fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {pays.map((e) => (
            <span key={e.side} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {e.side === 'yes' ? labels.yes : labels.no} <FlashValue value={e.payout} text={usdc2(e.payout)} kind="direction" />
            </span>
          ))}
        </span>
      )}
      <span style={{ ...pillStyle, background: pill.bg, color: pill.fg, fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{pill.label}</span>
      {hasPnlCard(p) ? (
        <PnlShareButton p={p} account={v.account} labels={labels} style={{ justifySelf: 'end' }} />
      ) : (
        <span aria-hidden="true" style={{ ...display, justifySelf: 'end' }}>
          →
        </span>
      )}
    </div>
  );
}

function ReadyToClaim(v: MeView) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 10 }}>
        <span style={{ ...display, fontSize: 24, letterSpacing: '-0.02em' }}>Ready to claim</span>
        <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>{v.pendingClaims}</span>
      </div>
      {v.claimItems.map((c) => {
        const { landed } = c;
        const amount = usdc2(claimAmount(c));
        return (
          <div key={claimKey(c)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', boxShadow: 'inset 0 1px 0 var(--line)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Link href={claimHref(c)} style={{ display: 'block', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
                {claimTitle(c)}
              </Link>
              <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 3 }}>{claimReason(c, v.labelsOf)}</div>
            </div>
            {landed ? (
              <span style={{ flex: 'none', height: 36, display: 'flex', alignItems: 'center', padding: '0 4px', ...mono, fontSize: 12, fontWeight: 700, color: 'var(--dim)' }}>✓ Claimed {amount}</span>
            ) : (
              <button
                type="button"
                onClick={() => v.openClaim(c)}
                className="mk-press97"
                style={{ flex: 'none', height: 36, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...mono, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}
              >
                Claim {amount} USDC
              </button>
            )}
          </div>
        );
      })}
      {v.pendingClaims === 0 && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 12, background: 'var(--raise)', boxShadow: 'var(--edge)', ...mono, fontSize: 12 }}>
          <div style={{ fontWeight: 700 }}>{v.allClaimed ? '✓ Everything claimed' : 'Nothing to claim yet'}</div>
          <div style={{ color: 'var(--dim)', marginTop: 4 }}>
            {v.allClaimed ? 'It’s in your balance. Winnings and refunds land here.' : 'Winnings and refunds show up here when a pool you bet on settles.'}
          </div>
        </div>
      )}
    </div>
  );
}

/// Pools this account created, counted on chain. Anyone can create one.
function Creator({ created }: { created: number }) {
  return (
    <div style={{ marginTop: 22, paddingTop: 14, boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>CREATOR</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <span style={{ flex: 'none', minWidth: 36, height: 36, padding: '0 6px', boxSizing: 'border-box', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontVariantNumeric: 'tabular-nums' }}>
          {created}
        </span>
        <div style={{ flex: 1, fontSize: 14 }}>{created === 0 ? 'You haven’t created a pool yet. Anyone can create one.' : `You’ve created ${created} ${created === 1 ? 'pool' : 'pools'}.`}</div>
        <Link href={CREATE_HREF} className="mk-press96" style={{ flex: 'none', height: 36, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', ...mono, fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
          Create a pool
        </Link>
      </div>
    </div>
  );
}
