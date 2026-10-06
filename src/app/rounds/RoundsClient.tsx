'use client';

import Link from 'next/link';

import { ListStateDesktop, ListStateMobile } from '@/components/ListState';
import { usdc2 } from '@/lib/pool-list';
import { closeTimeOf, commentary, entryCloseOf, mmss, phaseAt, RoundOutcome, V1_ASSET, type Round, type RoundPhase } from '@/lib/rounds-model';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { useIsCreator, useRounds } from '@/lib/use-rounds';
import { accountAddress, useUser } from '@/lib/use-user';

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

/// The Rounds tab: what is open for predictions, what is live, and the latest results, from MakoRoundsV1 itself.
export function RoundsClient() {
  const state = useRounds();
  const now = useLiveNowSec();
  const { user } = useUser();
  const isCreator = useIsCreator(user ? accountAddress(user) : null);

  const body = (narrow: boolean) => {
    if (state.kind === 'off') return narrow ? <ListStateMobile kind="rounds" state="not_open" /> : <ListStateDesktop kind="rounds" state="not_open" />;
    if (state.kind === 'loading' || now === null) return narrow ? <ListStateMobile kind="rounds" state="loading" /> : <ListStateDesktop kind="rounds" state="loading" />;
    if (state.kind === 'error') return narrow ? <ListStateMobile kind="rounds" state="error" onRetry={state.retry} /> : <ListStateDesktop kind="rounds" state="error" onRetry={state.retry} />;
    if (state.rounds.length === 0) return narrow ? <ListStateMobile kind="rounds" state="empty" /> : <ListStateDesktop kind="rounds" state="empty" />;
    return <RoundSections rounds={state.rounds} now={now} narrow={narrow} />;
  };

  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <Header narrow={false} isCreator={isCreator === true} />
        {body(false)}
      </div>
      <div className="mk-mob mk-m">
        <div style={{ padding: '0 20px' }}>
          <Header narrow isCreator={isCreator === true} />
          {body(true)}
        </div>
      </div>
    </>
  );
}

function Header({ narrow, isCreator }: { narrow: boolean; isCreator: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, margin: narrow ? '14px 0 14px' : '22px 0 20px' }}>
      <div>
        <h1 style={{ margin: 0, ...display, fontSize: narrow ? 40 : 56, lineHeight: 1, letterSpacing: '-0.04em' }}>Rounds</h1>
        <div style={{ fontSize: narrow ? 14 : 16, color: 'var(--dim)', marginTop: 8, maxWidth: 560 }}>
          {V1_ASSET.name} up or down in 15 minutes. Predict before a round starts; winners split the pot, settled on chain by Chainlink prices.
        </div>
      </div>
      {isCreator && (
        <Link href="/rounds/new" className="mk-press96" style={{ flex: 'none', height: 40, padding: '0 16px', display: 'flex', alignItems: 'center', borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', textDecoration: 'none', ...display, fontSize: 14 }}>
          Schedule a round
        </Link>
      )}
    </div>
  );
}

const SECTIONS: { title: string; phases: RoundPhase[] }[] = [
  { title: 'Open for predictions', phases: ['open'] },
  { title: 'Live now', phases: ['starting', 'live'] },
  { title: 'Waiting for the result', phases: ['settling'] },
  { title: 'Results', phases: ['settled', 'refunded'] },
];

export function RoundSections({ rounds, now, narrow }: { rounds: Round[]; now: number; narrow: boolean }) {
  const withPhase = rounds.map((r) => ({ r, phase: phaseAt(r, now) }));
  const open = withPhase.filter((x) => x.phase === 'open');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: narrow ? 22 : 28, paddingBottom: 32 }}>
      {open.length === 0 && <NextUp />}
      {SECTIONS.map((s) => {
        const list = withPhase
          .filter((x) => s.phases.includes(x.phase))
          // Open and live: soonest first. Results: newest first.
          .sort((a, b) => (s.title === 'Results' ? b.r.startTime - a.r.startTime : a.r.startTime - b.r.startTime));
        if (list.length === 0) return null;
        return (
          <section key={s.title} aria-label={s.title}>
            <h2 style={{ margin: '0 0 6px', padding: '0 4px', ...mono, fontSize: 11, fontWeight: 700, color: 'var(--dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {s.title} · {list.length}
            </h2>
            {list.map(({ r, phase }) => (
              <RoundRow key={r.id.toString()} round={r} phase={phase} now={now} narrow={narrow} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/// Nothing open: say so plainly rather than showing an empty list (rounds are scarce on purpose).
function NextUp() {
  return (
    <div style={{ padding: '16px 18px', borderRadius: 14, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
      <div style={{ ...display, fontSize: 20 }}>No round is open for predictions right now</div>
      <div style={{ fontSize: 14, color: 'var(--dim)', marginTop: 6, lineHeight: 1.5 }}>
        Rounds run on a schedule, a few a day. The next one appears here as soon as it is scheduled, and you can predict on it straight away.
      </div>
    </div>
  );
}

const clock = (unixS: number) => new Date(unixS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function countdownOf(r: Round, phase: RoundPhase, now: number): { label: string; value: string } {
  switch (phase) {
    case 'open':
      return { label: 'Predictions close in', value: mmss(entryCloseOf(r) - now) };
    case 'starting':
      return { label: 'Starts in', value: mmss(r.startTime - now) };
    case 'live':
      return { label: 'Result in', value: mmss(closeTimeOf(r) - now) };
    case 'settling':
      return { label: 'Settling', value: '…' };
    case 'settled':
      return { label: 'Result', value: r.outcome === RoundOutcome.Up ? 'UP' : 'DOWN' };
    case 'refunded':
      return { label: 'Result', value: 'Refund' };
  }
}

const PHASE_COLOUR: Record<RoundPhase, string> = {
  open: 'var(--mako-signal)',
  starting: 'var(--mako-teal)',
  live: 'var(--mako-teal)',
  settling: 'var(--raise2)',
  settled: 'var(--mako-canvas-fg)',
  refunded: 'var(--raise2)',
};
const PHASE_LABEL: Record<RoundPhase, string> = { open: 'Open', starting: 'Starting', live: 'Live', settling: 'Settling', settled: 'Settled', refunded: 'Refunded' };

function RoundRow({ round: r, phase, now, narrow }: { round: Round; phase: RoundPhase; now: number; narrow: boolean }) {
  const total = r.upPool + r.downPool;
  const upPct = total === 0n ? 50 : Number((r.upPool * 100n + total / 2n) / total);
  const cd = countdownOf(r, phase, now);
  const pillFg = phase === 'settled' ? 'var(--mako-canvas)' : phase === 'settling' || phase === 'refunded' ? 'var(--mako-canvas-fg)' : '#000';
  return (
    <Link
      href={`/rounds/${r.id.toString()}`}
      style={{ display: 'block', padding: narrow ? '14px 4px' : '16px 4px', boxShadow: 'inset 0 1px 0 var(--line)', color: 'inherit', textDecoration: 'none' }}
      aria-label={`Round ${r.id.toString()}, ${V1_ASSET.pair}, ${PHASE_LABEL[phase]}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ height: 22, display: 'flex', alignItems: 'center', padding: '0 9px', borderRadius: 9999, background: PHASE_COLOUR[phase], color: pillFg, boxShadow: 'var(--edge)', fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              {PHASE_LABEL[phase]}
            </span>
            <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>
              {V1_ASSET.pair} · #{r.id.toString()} · {clock(r.startTime)} to {clock(closeTimeOf(r))}
            </span>
          </div>
          <div style={{ ...display, fontSize: narrow ? 20 : 24, marginTop: 8, letterSpacing: '-0.02em' }}>
            {V1_ASSET.symbol} up or down by {clock(closeTimeOf(r))}?
          </div>
        </div>
        <div style={{ flex: 'none', textAlign: 'right' }}>
          <div style={{ ...mono, fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase' }}>{cd.label}</div>
          <div style={{ ...display, fontSize: narrow ? 24 : 32, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{cd.value}</div>
        </div>
      </div>
      <div style={{ display: 'flex', height: 10, borderRadius: 9999, overflow: 'hidden', marginTop: 12, background: 'var(--raise2)' }}>
        {total > 0n && (
          <>
            <div style={{ width: `${upPct}%`, background: 'var(--mako-signal)' }} />
            <div style={{ flex: 1, background: 'var(--mako-red)' }} />
          </>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 8, ...mono, fontSize: 12 }}>
        <span>
          UP {usdc2(r.upPool)} · DOWN {usdc2(r.downPool)} USDC
        </span>
        <span style={{ color: 'var(--dim)' }}>
          {r.upEntrants + r.downEntrants} {r.upEntrants + r.downEntrants === 1 ? 'player' : 'players'}
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 8, lineHeight: 1.45 }}>{commentary(r, now)}</div>
    </Link>
  );
}
