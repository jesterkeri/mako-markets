'use client';

import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';

import { SheetFrame, Svg } from '@/components/ConfirmSheet';
import { ShareLinks } from '@/components/PoolShareSheet';
import type { MeBetWire } from '@/app/api/me/bets/route';
import { monadTestnet } from '@/lib/chain';
import type { MePosition } from '@/lib/me-stats';
import { betLogIndex, cardImage, cardPath, type CardState } from '@/lib/pnl-card';
import { dayTime } from '@/lib/pool-rules';
import { usdc2 } from '@/lib/pool-list';

// Share one bet's card (docs/pnl-share-card): bet placed while the pool is unsettled, win or loss once it settles. One
// card per bet (owner, 2026-10-23). Me's sheet lists the account's bets on the pool, from its own-account route
// (/api/me/bets); the ledger behind that route runs behind the chain, so the rows are checked against the stake Me read
// on chain and, until they add up, the sheet says so instead of offering a partial list. The bet confirmation shares
// the bet it just placed, found in its own receipt (useBetLog). Each preview has Download and Copy image, then the
// pool invite's share targets and Copy link, all carrying the card's own link (Joshua 2026-10-24).

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const CLOSE = 'M7 7l10 10M17 7L7 17';

type Labels = { yes: string; no: string };

/// Which card a Me position shares: the result for a settled win or loss, bet placed while unsettled; a refund none.
export function cardStateOf(p: MePosition): CardState | null {
  if (p.settlement?.kind === 'won' || p.settlement?.kind === 'lost') return 'result';
  return !p.market.resolved && p.stake > 0n ? 'placed' : null;
}

export const hasPnlCard = (p: MePosition) => cardStateOf(p) !== null;

const sheetTitle = (state: CardState) => (state === 'placed' ? 'Share your call' : 'Share your result');

export function PnlShareButton({ p, account, labels, style }: { p: MePosition; account: `0x${string}`; labels: Labels; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  const state = cardStateOf(p);
  if (!state) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${sheetTitle(state)} on ${p.market.question}`}
        className="mk-press96"
        style={{ height: 32, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...mono, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', ...style }}
      >
        Share
      </button>
      {open && <PnlShareSheet poolId={p.market.id} question={p.market.question} stake={p.bet} state={state} account={account} labels={labels} onClose={() => setOpen(false)} />}
    </>
  );
}

type Load = { status: 'loading' } | { status: 'error' } | { status: 'behind' } | { status: 'ready'; bets: MeBetWire[] };

/// The rows add up to the stake read on chain, side by side.
export function betsMatchStake(bets: readonly MeBetWire[], stake: { yes: bigint; no: bigint }): boolean {
  const sum = (yes: boolean) => bets.filter((b) => b.isYes === yes).reduce((s, b) => s + BigInt(b.amount), 0n);
  return bets.length > 0 && sum(true) === stake.yes && sum(false) === stake.no;
}

/// One account's cards on one pool. `onPool` adds a link to the pool's own invite (the pool page's Share).
export function PnlShareSheet({
  poolId: id,
  question,
  stake,
  state,
  account,
  labels,
  onClose,
  onPool,
}: {
  poolId: bigint;
  question: string;
  /// The account's stake per side, read on chain.
  stake: { yes: bigint; no: bigint };
  state: CardState;
  account: `0x${string}`;
  labels: Labels;
  onClose: () => void;
  onPool?: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [pick, setPick] = useState(0);

  const { yes, no } = stake;
  useEffect(() => {
    let live = true;
    fetch(`/api/me/bets?account=${account}&pool=${id.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const { bets } = (await r.json()) as { bets: MeBetWire[] };
        if (live) setLoad(betsMatchStake(bets, { yes, no }) ? { status: 'ready', bets } : { status: 'behind' });
      })
      .catch(() => live && setLoad({ status: 'error' }));
    return () => {
      live = false;
    };
  }, [account, id, yes, no]);

  const bet = load.status === 'ready' ? load.bets[pick] : null;

  return (
    <SheetShell title={sheetTitle(state)} onClose={onClose}>
      {load.status === 'loading' && <Note>Loading your bets…</Note>}
      {load.status === 'error' && <Note>Your bets could not be loaded. Close this and try again.</Note>}
      {load.status === 'behind' && <Note>Your latest bets on this pool are still being counted. Try again in a few minutes.</Note>}

      {load.status === 'ready' && load.bets.length > 1 && (
        <div role="radiogroup" aria-label="Which bet" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {load.bets.map((b, i) => (
            <button
              key={`${b.tx}:${b.log}`}
              type="button"
              role="radio"
              aria-checked={i === pick}
              onClick={() => setPick(i)}
              className="m3-press"
              style={{ display: 'flex', alignItems: 'center', gap: 10, height: 40, padding: '0 14px', borderRadius: 12, background: i === pick ? 'var(--mako-canvas-fg)' : 'var(--raise)', color: i === pick ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', ...mono, fontSize: 12, fontWeight: 700, textAlign: 'left' }}
            >
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dayTime(b.at)}</span>
              <span>{b.isYes ? labels.yes : labels.no}</span>
              <span>{usdc2(BigInt(b.amount))} USDC</span>
            </button>
          ))}
        </div>
      )}

      {bet && <CardPreview key={`${bet.tx}:${bet.log}`} poolId={id} page={cardPath(id, bet.tx, bet.log, state)} question={question} fileName={`mako-market-pool-${id.toString()}-bet-${pick + 1}.png`} />}
      {onPool && (
        <button type="button" onClick={onPool} className="m3-press" style={{ display: 'block', marginTop: 14, padding: '6px 0', ...mono, fontSize: 13, fontWeight: 700, color: 'var(--dim)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
          Share the pool instead →
        </button>
      )}
    </SheetShell>
  );
}

/// The bet confirmation's card: the bet placed card for the bet in that transaction.
export function BetCardSheet({ poolId, tx, log, question, onClose }: { poolId: bigint; tx: string; log: number; question: string; onClose: () => void }) {
  return (
    <SheetShell title={sheetTitle('placed')} onClose={onClose}>
      <CardPreview poolId={poolId} page={cardPath(poolId, tx, log, 'placed')} question={question} fileName={`mako-market-pool-${poolId.toString()}-bet.png`} />
    </SheetShell>
  );
}

export type BetLog = { status: 'idle' | 'finding' | 'none' } | { status: 'found'; log: number };

/// The log index of the bet a confirmed transaction placed, from its receipt on the public chain. The confirmation's
/// Share button stays disabled until the receipt names exactly one BetPlaced log for this pool and account.
export function useBetLog(txHash: string | undefined, poolId: bigint, account: string | null): BetLog {
  const client = usePublicClient({ chainId: monadTestnet.id });
  const [found, setFound] = useState<{ key: string; result: BetLog } | null>(null);
  const key = txHash && account ? `${txHash}:${poolId.toString()}:${account}` : null;
  useEffect(() => {
    if (!key || !client) return;
    let live = true;
    client
      .waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 30_000 })
      .then((r) => {
        const log = r.status === 'success' ? betLogIndex(r.logs, poolId, account!) : null;
        if (live) setFound({ key, result: log === null ? { status: 'none' } : { status: 'found', log } });
      })
      .catch(() => live && setFound({ key, result: { status: 'none' } }));
    return () => {
      live = false;
    };
  }, [key, client, txHash, poolId, account]);
  if (!key) return { status: 'idle' };
  return found?.key === key ? found.result : { status: 'finding' };
}

function SheetShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <SheetFrame label={title} onScrim={onClose} width={640} yellowOnDark={false}>
      {(variant) => (
        <div style={{ maxHeight: variant === 'mobile' ? 'calc(100dvh - 72px)' : 'calc(100dvh - 160px)', overflowY: 'auto', overscrollBehavior: 'contain', padding: 2, margin: variant === 'mobile' ? '-6px -2px -2px' : -2 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ ...display, fontSize: 22 }}>{title}</span>
            <button onClick={onClose} aria-label="Close" className="m3-press" style={{ width: 40, height: 40, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={CLOSE} size={16} />
            </button>
          </div>
          {children}
        </div>
      )}
    </SheetFrame>
  );
}

/// One card's preview with Download and Copy image, then the share targets and Copy link for the card's page.
function CardPreview({ poolId, page, question, fileName }: { poolId: bigint; page: string; question: string; fileName: string }) {
  const [done, setDone] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const image = cardImage(page);

  const pngBlob = async () => {
    const r = await fetch(image);
    if (!r.ok) throw new Error(String(r.status));
    return r.blob();
  };
  const download = async () => {
    try {
      const url = URL.createObjectURL(await pngBlob());
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      setDone('Downloaded');
    } catch {
      setDone('Download failed');
    }
  };
  const copy = async () => {
    try {
      // The blob goes in as a promise, so Safari keeps the tap's permission while the image loads.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
      setDone('Image copied');
    } catch {
      setDone('Copy failed');
    }
  };
  const canCopy = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

  const action: React.CSSProperties = { flex: 1, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9999, ...mono, fontSize: 13, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' };

  if (broken) return <Note>This card can’t be drawn just now. Close this and try again in a minute.</Note>;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} width={1600} height={900} alt={`Your share card for ${question}`} onError={() => setBroken(true)} style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '16 / 9', borderRadius: 14, background: '#000' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="button" onClick={download} className="m3-press" style={{ ...action, background: 'var(--raise)', color: 'var(--mako-canvas-fg)' }}>
          Download
        </button>
        {canCopy && (
          <button type="button" onClick={copy} className="m3-press" style={{ ...action, background: 'var(--raise)', color: 'var(--mako-canvas-fg)' }}>
            Copy image
          </button>
        )}
      </div>
      <ShareLinks id={poolId} question={question} path={page} />
      <div aria-live="polite" style={{ ...mono, fontSize: 12, color: 'var(--dim)', minHeight: 18, marginTop: 8 }}>
        {done}
      </div>
    </>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 14, borderRadius: 12, background: 'var(--raise)', ...mono, fontSize: 12 }}>{children}</div>;
}
