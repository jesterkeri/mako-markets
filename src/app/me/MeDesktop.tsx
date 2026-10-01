'use client';

import Link from 'next/link';
import { useRef } from 'react';

import { ListStateDesktop } from '@/components/ListState';
import { CIRCLE_FAUCET_URL } from '@/lib/list-states';
import { estPayouts, ME_RANGES, positionMeta, resultLabel, signedUsdc, type MePosition } from '@/lib/me-stats';
import { usdc2 } from '@/lib/pool-list';
import { tourHref } from '@/lib/tour';
import { formatAddress } from '@/lib/user-display';

import {
  AvatarFace,
  BAR,
  claimWhy,
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
import { validateDisplayName } from './profile-rules';

// Me on desktop (11a), in the terminal look: identity and test USDC, the four totals, profit and badges, then the
// positions beside Ready to claim.

/// How to play from its first step.
const TOUR_START = tourHref(0);
const COLS = 'minmax(0,1fr) 90px 110px 150px 120px 20px';

export function MeDesktop(v: MeView) {
  return (
    <div style={{ paddingBottom: 28 }}>
      <Identity {...v} />
      {v.photoOpen && <PhotoPanel {...v} />}
      <Totals {...v} />
      {v.chain.status === 'ready' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 40, marginTop: 26, padding: '0 4px' }}>
            <Profit {...v} />
            <Badges />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 40, marginTop: 26, padding: '0 4px' }}>
            <Positions {...v} />
            <div>
              <ReadyToClaim {...v} />
              <Creator created={v.chain.created} />
            </div>
          </div>
        </>
      ) : (
        <div style={{ marginTop: 26 }}>
          <ListStateDesktop kind="me" state={v.chain.status} onRetry={v.retry} explorerHref={v.explorerHref} />
        </div>
      )}
    </div>
  );
}

function Identity(v: MeView) {
  const { user, account, name, label, initial, emailAccount, editing, draft, edit } = v;
  const invalid = editing ? validateDisplayName(draft) : null;
  const unchanged = draft.trim() === (name ?? '');
  const canSave = !invalid && !unchanged && !edit.nameBusy;
  const hint = invalid ?? (edit.nameError || 'Looks good. This is how you show up in comments and the leaderboard.');
  const hintIsError = invalid !== null || edit.nameError !== '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '22px 4px 24px' }}>
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
      <TestUsdc account={account} />
    </div>
  );
}

/// Test USDC comes from Circle's faucet, which asks for the account's address: the address and Copy sit beside it.
function TestUsdc({ account }: { account: `0x${string}` }) {
  return (
    <div data-tour-anchor="test-usdc" style={{ flex: 'none', width: 380, padding: '16px 18px', borderRadius: 14, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...display, fontSize: 20 }}>Test USDC</span>
        <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>MONAD TESTNET</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 4 }}>Free test USDC to try Mako Market comes from Circle’s faucet. It asks for your address.</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
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

function Amount({ value, colour, suffix = ' USDC' }: { value: Loadable<bigint>; colour?: string; suffix?: string }) {
  const big: React.CSSProperties = { ...display, fontSize: 30, letterSpacing: '-0.02em', marginTop: 4, fontVariantNumeric: 'tabular-nums' };
  if (value.status === 'loading') return <div aria-label="Loading" style={{ width: 150, height: 30, borderRadius: 8, marginTop: 6, background: BAR }} />;
  if (value.status === 'error') return <div style={{ ...big, fontSize: 22, marginTop: 8, color: 'var(--dim)' }}>Unavailable</div>;
  return <div style={{ ...big, color: colour ?? 'var(--mako-canvas-fg)' }}>{`${usdc2(value.value)}${suffix}`}</div>;
}

function Totals(v: MeView) {
  const c = v.chain;
  const from = (pick: (s: Extract<typeof c, { status: 'ready' }>['stats']) => bigint): Loadable<bigint> => (c.status === 'ready' ? { status: 'ready', value: pick(c.stats) } : c);
  const cells: [string, Loadable<bigint>, string?][] = [
    ['BALANCE', v.balance],
    ['IN PLAY', from((s) => s.inPlay)],
    ['READY TO CLAIM', v.ready, 'var(--up-text)'],
    ['WON ALL TIME', from((s) => s.wonAllTime)],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', boxShadow: 'inset 0 1px 0 var(--line), inset 0 -1px 0 var(--line)' }}>
      {cells.map(([label, value, colour]) => (
        <div key={label} style={{ padding: '14px 18px', boxShadow: 'inset 1px 0 0 var(--line)' }}>
          <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>{label}</div>
          <Amount value={value} colour={colour} />
        </div>
      ))}
    </div>
  );
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
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 18, padding: '10px 0', boxShadow: 'inset 0 1px 0 var(--line)', ...mono, fontSize: 10, color: 'var(--dim)' }}>
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
    <div className="mk-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 18, alignItems: 'center', padding: '15px 0', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <div style={{ minWidth: 0 }}>
        <Link href={poolHref(p.market.id)} className="mk-rowlink" style={{ display: 'block', ...display, fontSize: 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
          {p.market.question}
        </Link>
        <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>Pool · {v.now === null ? '' : positionMeta(p, v.now)}</div>
      </div>
      <span style={{ ...pillStyle, background: side.bg, color: side.fg, fontSize: 11, fontWeight: 800 }}>{side.text}</span>
      <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700 }}>{usdc2(p.stake)}</span>
      {p.settlement ? (
        <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700, color: resultColour(p) }}>{resultLabel(p.settlement, p.stake)}</span>
      ) : pays.length === 1 ? (
        <span style={{ textAlign: 'right', ...mono, fontSize: 14, fontWeight: 700 }}>{usdc2(pays[0].payout)} USDC</span>
      ) : (
        <span style={{ textAlign: 'right', ...mono, fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {pays.map((e) => (
            <span key={e.side} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {e.side === 'yes' ? labels.yes : labels.no} {usdc2(e.payout)}
            </span>
          ))}
        </span>
      )}
      <span style={{ ...pillStyle, background: pill.bg, fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{pill.label}</span>
      <span aria-hidden="true" style={{ ...display }}>
        →
      </span>
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
      {v.claimItems.map(({ p, landed }) => {
        const amount = usdc2(p.claim ?? 0n);
        return (
          <div key={p.market.id.toString()} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', boxShadow: 'inset 0 1px 0 var(--line)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Link href={poolHref(p.market.id)} style={{ display: 'block', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
                {p.market.question}
              </Link>
              <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 3 }}>{claimWhy(p, v.labelsOf(p))}</div>
            </div>
            {landed ? (
              <span style={{ flex: 'none', height: 36, display: 'flex', alignItems: 'center', padding: '0 4px', ...mono, fontSize: 12, fontWeight: 700, color: 'var(--dim)' }}>✓ Claimed {amount}</span>
            ) : (
              <button
                type="button"
                onClick={() => v.openClaim(p)}
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
