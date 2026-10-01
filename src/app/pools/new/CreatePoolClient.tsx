'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useDiscover } from './use-discover';

import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';
import { SignInLink } from '@/components/signin/SignInLink';
import { explorerUrl } from '@/lib/chain';
import { MarketType, type MarketWithId } from '@/lib/contract';
import { CRYPTO_ASSETS, formatStrikeForDisplay, roundStrike } from '@/lib/crypto-assets';
import { useCreatorCreatesToday, useMarkets, useUsdcBalance } from '@/lib/hooks';
import { MAX_DURATION_SEC, sportsTimestamps } from '@/lib/market-timing';
import { toBytes32 } from '@/lib/oracle';
import { MIN_BET, parseAmount } from '@/lib/pool-bet-rules';
import { buildPool, DURATIONS, type BasketballQuestion, type BuiltPool, type CreateDraft, type CreateKind, type FootballQuestion, type PriceKind } from '@/lib/pool-create';
import { CAT_STYLE, usdc2, usdcExact, type PoolCat } from '@/lib/pool-list';
import { dayTime, poolRules } from '@/lib/pool-rules';
import { getAssetsByClass } from '@/lib/price-feed-assets';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { usePoolTx } from '@/lib/use-pool-tx';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';
import { formatAddress } from '@/lib/user-display';

// Create a pool (10a), rebuilt around the choices Mako Market can settle: a football or NBA fixture with a question
// type, or a price target on crypto, forex, commodities or stocks. The question, its YES/NO rules and its source are
// written from those choices (pool-create.ts, pool-rules.ts), exactly as the resolver reads them; a free-text question
// could never be settled, only refunded. Four steps: Market, Timing and source, Review, Live.

const MIN_SEED = 1_000_000n;
const MAX_CREATES_PER_DAY = 10;

const KINDS: readonly { key: CreateKind; label: string; cat: PoolCat }[] = [
  { key: 'crypto', label: 'Crypto', cat: 'CRYPTO' },
  { key: 'football', label: 'Football', cat: 'FOOTBALL' },
  { key: 'basketball', label: 'NBA', cat: 'NBA' },
  { key: 'forex', label: 'Forex', cat: 'FOREX' },
  { key: 'commodities', label: 'Commodities', cat: 'COMMODITIES' },
  { key: 'stocks', label: 'Stocks', cat: 'STOCKS' },
];

const FOOTBALL_QUESTIONS: readonly { key: FootballQuestion; label: string }[] = [
  { key: 'home_win', label: 'Home win' },
  { key: 'away_win', label: 'Away win' },
  { key: 'draw', label: 'Draw' },
  { key: 'over', label: 'Over 2.5 goals' },
];
const NBA_QUESTIONS: readonly { key: BasketballQuestion; label: string }[] = [
  { key: 'home_win', label: 'Home win' },
  { key: 'away_win', label: 'Away win' },
  { key: 'over', label: 'Over points' },
  { key: 'under', label: 'Under points' },
];

type Fixture = { id: number; homeTeam: string; awayTeam: string; kickoffIso: string };
type Game = { id: number; homeTeam: string; visitorTeam: string; tipoffIso: string };
type Step = 1 | 2 | 3 | 4;

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const label: React.CSSProperties = { ...mono, fontSize: 11, color: 'var(--dim)', letterSpacing: '0.04em' };

function assetsFor(kind: PriceKind): { symbol: string; label: string }[] {
  return kind === 'crypto' ? CRYPTO_ASSETS.map((a) => ({ symbol: a.symbol, label: a.label })) : getAssetsByClass(kind).map((a) => ({ symbol: a.symbol, label: a.label }));
}

/// A match time with its date: fixtures run up to weeks out, so a weekday alone is ambiguous.
const dateTime = (sec: number) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sec * 1000));

/// When a fixture can take a pool: its close time (start plus the match window) must be within the contract's 7 days.
function opensForPoolsAt(startIso: string, kind: 'football' | 'basketball'): number | null {
  const ms = new Date(startIso).getTime();
  if (!Number.isFinite(ms)) return null;
  const { closeTime } = sportsTimestamps(Math.floor(ms / 1000), kind);
  return Number(closeTime) - MAX_DURATION_SEC;
}

/// The built pool as a Market, so the pool page's rules and preview describe it exactly as they will once it exists.
function asMarket(pool: BuiltPool, nowSec: number, creator: `0x${string}`, seed: bigint, seedYes: boolean): MarketWithId {
  return {
    id: 0n,
    creator,
    mType: pool.mType,
    oracleRef: toBytes32(pool.oracleRef),
    question: pool.question,
    createdAt: BigInt(nowSec),
    closeTime: pool.closeTime,
    bettingCloseTime: pool.bettingCloseTime,
    totalYes: seedYes ? seed : 0n,
    totalNo: seedYes ? 0n : seed,
    yesBettorCount: seedYes ? 1 : 0,
    noBettorCount: seedYes ? 0 : 1,
    outcome: 0,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
  };
}

export function CreatePoolClient() {
  const now = useLiveNowSec();
  const { user } = useUser();
  const account = user ? accountAddress(user) : null;
  const balanceQ = useUsdcBalance(account ?? undefined);
  const balance = typeof balanceQ.data === 'bigint' ? balanceQ.data : null;
  const createsQ = useCreatorCreatesToday(account ?? undefined);
  // creatorCreatesToday returns (count, remaining) for the current UTC day; remaining is the contract's own answer.
  const createsLeft = createsQ.data ? (createsQ.data as readonly [bigint, bigint])[1] : null;
  const { markets } = useMarkets();

  const [step, setStep] = useState<Step>(1);
  const [kind, setKind] = useState<CreateKind>('crypto');
  const [symbols, setSymbols] = useState<Record<PriceKind, string>>({ crypto: 'BTC', forex: 'EURUSD', commodities: 'XAUUSD', stocks: 'AAPL' });
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [strikeText, setStrikeText] = useState('');
  const [durationSec, setDurationSec] = useState(3600);
  const [fixtureId, setFixtureId] = useState<number | null>(null);
  const [footballQ, setFootballQ] = useState<FootballQuestion>('home_win');
  const [gameId, setGameId] = useState<number | null>(null);
  const [nbaQ, setNbaQ] = useState<BasketballQuestion>('home_win');
  const [totalText, setTotalText] = useState('');
  const [seedText, setSeedText] = useState('1');
  const [seedYes, setSeedYes] = useState(true);
  const [sheetSpec, setSheetSpec] = useState<ConfirmSpec | null>(null);

  const football = useDiscover<{ fixtures: Fixture[] }>(kind === 'football' ? '/api/discover/football' : null);
  const nba = useDiscover<{ games: Game[] }>(kind === 'basketball' ? '/api/discover/basketball' : null);
  const crypto = useDiscover<{ prices: Record<string, { usd: number }> }>(kind === 'crypto' ? '/api/discover/crypto' : null, 10_000);

  const tx = usePoolTx();
  useEffect(() => {
    if (tx.phase.step === 'done') setStep(4);
  }, [tx.phase.step]);

  const priceKind = kind === 'football' || kind === 'basketball' ? null : kind;
  const symbol = priceKind ? symbols[priceKind] : '';
  const livePrice = priceKind === 'crypto' ? (crypto.data?.prices?.[symbol]?.usd ?? null) : null;
  const defaultStrike = livePrice ? roundStrike(livePrice * (direction === 'above' ? 1.01 : 0.99)) : 0;
  const strike = strikeText.trim() === '' ? defaultStrike : Number(strikeText);

  const fixture = football.data?.fixtures.find((f) => f.id === fixtureId) ?? null;
  const game = nba.data?.games.find((g) => g.id === gameId) ?? null;

  const draft: CreateDraft | null = useMemo(() => {
    if (priceKind) return { kind: priceKind, symbol, direction, strike, durationSec };
    if (kind === 'football') return fixture ? { kind: 'football', fixture, question: footballQ } : null;
    return game ? { kind: 'basketball', game, question: nbaQ, total: Number(totalText) } : null;
  }, [priceKind, symbol, direction, strike, durationSec, kind, fixture, footballQ, game, nbaQ, totalText]);

  const built = draft && now !== null ? buildPool(draft, now) : null;
  const pool = built && built.ok ? built.pool : null;
  const seed = parseAmount(seedText);
  const seedProblem =
    seed === null || seed < MIN_SEED
      ? 'Your first bet must be at least 1 USDC.'
      : balance !== null && seed > balance
        ? `Not enough USDC. Your balance is ${usdc2(balance)}.`
        : createsLeft === 0n
          ? `You have created ${MAX_CREATES_PER_DAY} pools today, the most an account can make per day (UTC). Try again tomorrow.`
          : null;
  const market = pool && now !== null ? asMarket(pool, now, account ?? '0x0000000000000000000000000000000000000000', seed ?? MIN_SEED, seedYes) : null;
  const mine = useMemo(() => (account ? markets.filter((m) => m.creator.toLowerCase() === account.toLowerCase()) : []), [markets, account]);
  const bothSides = mine.length ? Math.round((mine.filter((m) => m.totalYes > 0n && m.totalNo > 0n).length * 100) / mine.length) : null;

  const openCreate = () => {
    if (!pool || !draft || seed === null || seedProblem || tx.tx) return;
    const side = seedYes ? 'YES' : 'NO';
    setSheetSpec({
      glyph: '+',
      glyphColor: 'var(--mako-signal)',
      title: 'Create pool',
      confirmLabel: `Confirm · ${usdcExact(seed)} USDC`,
      pendingTitle: 'Creating your pool',
      rows: [
        { label: 'Question', value: pool.question },
        { label: 'Betting closes', value: dayTime(Number(pool.bettingCloseTime)) },
        { label: 'Your first bet', value: `${usdcExact(seed)} USDC on ${side}`, tone: seedYes ? 'up' : 'no' },
      ],
      note: 'Your first bet goes into the pool like any other bet. If nobody takes the other side, everyone is refunded.',
      doneTitle: 'Your pool is live',
      doneBody: pool.question,
      doneSecondary: { label: 'View in Pools', href: '/pools' },
    });
    tx.open({ kind: 'create', draft, seed, seedYes });
  };

  const v: ViewProps = {
    now,
    user,
    step,
    setStep,
    kind,
    setKind: (k) => {
      setKind(k);
      setStrikeText('');
    },
    priceKind,
    symbol,
    setSymbol: (s) => {
      if (priceKind) setSymbols({ ...symbols, [priceKind]: s });
      setStrikeText('');
    },
    direction,
    setDirection,
    strikeText,
    setStrikeText,
    strike,
    livePrice,
    durationSec,
    setDurationSec,
    fixtures: football.data?.fixtures ?? null,
    fixturesError: football.error,
    fixtureId,
    setFixtureId,
    footballQ,
    setFootballQ,
    games: nba.data?.games ?? null,
    gamesError: nba.error,
    gameId,
    setGameId,
    nbaQ,
    setNbaQ,
    totalText,
    setTotalText,
    built,
    pool,
    market,
    seedText,
    setSeedText,
    seedYes,
    setSeedYes,
    seedProblem,
    openCreate,
    createdId: tx.createdId,
    doneTx: tx.phase.step === 'done' ? tx.phase.txHash : undefined,
    reset: () => {
      tx.close();
      setStep(1);
    },
    stats: account ? { pools: mine.length, bothSides } : null,
  };

  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <CreateView {...v} variant="desktop" />
      </div>
      <div className="mk-mob mk-m">
        <CreateView {...v} variant="mobile" />
      </div>
      {tx.tx && sheetSpec && user && (
        <ConfirmSheet
          spec={sheetSpec}
          phase={tx.phase}
          wallet={user.authType === 'magic' ? { kind: 'mako', address: user.safeAddress } : { kind: 'external', address: user.walletAddress }}
          onConfirm={tx.confirm}
          onCancel={tx.close}
          onRetry={tx.retry}
          onClose={tx.close}
        />
      )}
    </>
  );
}

type ViewProps = {
  now: number | null;
  user: AuthedUser | null;
  step: Step;
  setStep: (s: Step) => void;
  kind: CreateKind;
  setKind: (k: CreateKind) => void;
  priceKind: PriceKind | null;
  symbol: string;
  setSymbol: (s: string) => void;
  direction: 'above' | 'below';
  setDirection: (d: 'above' | 'below') => void;
  strikeText: string;
  setStrikeText: (s: string) => void;
  strike: number;
  livePrice: number | null;
  durationSec: number;
  setDurationSec: (n: number) => void;
  fixtures: Fixture[] | null;
  fixturesError: boolean;
  fixtureId: number | null;
  setFixtureId: (n: number) => void;
  footballQ: FootballQuestion;
  setFootballQ: (q: FootballQuestion) => void;
  games: Game[] | null;
  gamesError: boolean;
  gameId: number | null;
  setGameId: (n: number) => void;
  nbaQ: BasketballQuestion;
  setNbaQ: (q: BasketballQuestion) => void;
  totalText: string;
  setTotalText: (s: string) => void;
  built: ReturnType<typeof buildPool> | null;
  pool: BuiltPool | null;
  market: MarketWithId | null;
  seedText: string;
  setSeedText: (s: string) => void;
  seedYes: boolean;
  setSeedYes: (b: boolean) => void;
  seedProblem: string | null;
  openCreate: () => void;
  createdId: bigint | null;
  doneTx: string | undefined;
  reset: () => void;
  stats: { pools: number; bothSides: number | null } | null;
};

// ---------------------------------------------------------------------------------------------------------------
// Pieces

function Pill({ on, onClick, children, tone, tourPoint }: { on: boolean; onClick: () => void; children: React.ReactNode; tone?: 'yes' | 'no'; tourPoint?: string }) {
  const bg = on ? (tone === 'no' ? 'var(--mako-red)' : tone === 'yes' ? 'var(--mako-signal)' : 'var(--mako-signal)') : 'var(--raise)';
  return (
    <button type="button" onClick={onClick} aria-pressed={on} data-tour-point={tourPoint} className="mk-press96" style={{ flex: 'none', height: 34, padding: '0 14px', borderRadius: 9999, background: bg, color: on ? '#000' : 'var(--mako-canvas-fg)', boxShadow: on ? 'var(--edge)' : 'none', ...mono, fontSize: 12, fontWeight: 700 }}>
      {children}
    </button>
  );
}

function Field({ title, children, hint, tourAnchor }: { title: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode; tourAnchor?: string }) {
  return (
    <div data-tour-anchor={tourAnchor} style={{ marginTop: 18 }}>
      <div style={label}>{title}</div>
      <div style={{ marginTop: 8 }}>{children}</div>
      {hint && <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

const input: React.CSSProperties = { height: 52, width: '100%', boxSizing: 'border-box', padding: '0 16px', border: 0, outline: 0, borderRadius: 12, background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', color: 'var(--mako-canvas-fg)', ...display, fontSize: 20 };

function primaryButton(enabled: boolean): React.CSSProperties {
  return { height: 52, padding: '0 22px', borderRadius: 9999, background: enabled ? 'var(--mako-signal)' : 'var(--raise2)', color: enabled ? '#000' : 'var(--dim)', boxShadow: enabled ? 'var(--edge)' : 'none', ...display, fontSize: 17, cursor: enabled ? 'pointer' : 'not-allowed' };
}

function Steps({ step }: { step: Step }) {
  const names = ['Market', 'Timing and source', 'Review', 'Live'];
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {names.map((n, i) => (
        <div key={n} style={{ flex: 1, minWidth: 0 }}>
          <div style={{ height: 4, borderRadius: 9999, background: i + 1 <= step ? 'var(--mako-canvas-fg)' : 'var(--raise2)' }} />
          <div style={{ ...mono, fontSize: 11, marginTop: 8, color: i + 1 === step ? 'var(--mako-canvas-fg)' : 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {i + 1} · {n}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

function StepMarket(v: ViewProps) {
  return (
    <>
      <Field title="CATEGORY" tourAnchor="create-form">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {KINDS.map((k, i) => (
            <Pill key={k.key} on={v.kind === k.key} onClick={() => v.setKind(k.key)} tourPoint={i === 0 ? 'create-form' : undefined}>
              {k.label}
            </Pill>
          ))}
        </div>
      </Field>
      {v.priceKind ? <PriceChoice {...v} /> : v.kind === 'football' ? <FootballChoice {...v} /> : <NbaChoice {...v} />}
      <Field title="QUESTION · WRITTEN FROM YOUR CHOICES SO IT CAN BE SETTLED">
        <div style={{ minHeight: 64, padding: '14px 16px', borderRadius: 12, background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', ...display, fontSize: 22, lineHeight: 1.2, color: v.pool ? 'var(--mako-canvas-fg)' : 'var(--dim)' }}>
          {v.pool?.question ?? (v.built && !v.built.ok ? v.built.reason : 'Pick what the pool is about.')}
        </div>
      </Field>
      {v.market && <YesNo market={v.market} />}
    </>
  );
}

function PriceChoice(v: ViewProps) {
  const pk = v.priceKind!;
  return (
    <>
      <Field title="ASSET">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {assetsFor(pk).map((a) => (
            <Pill key={a.symbol} on={v.symbol === a.symbol} onClick={() => v.setSymbol(a.symbol)}>
              {a.symbol}
            </Pill>
          ))}
        </div>
      </Field>
      <Field title="YES IF THE PRICE IS">
        <div style={{ display: 'flex', gap: 6 }}>
          <Pill on={v.direction === 'above'} onClick={() => v.setDirection('above')}>
            Above
          </Pill>
          <Pill on={v.direction === 'below'} onClick={() => v.setDirection('below')}>
            Below
          </Pill>
        </div>
      </Field>
      <Field
        title={`TARGET ${pk === 'forex' ? 'RATE' : 'PRICE (USD)'}`}
        hint={v.livePrice ? `Now ${formatStrikeForDisplay(v.livePrice)} USD. The default target is 1% ${v.direction} it.` : pk === 'crypto' ? 'The live price is unavailable right now. Enter a target.' : undefined}
      >
        <input
          value={v.strikeText}
          placeholder={v.strike > 0 ? String(v.strike) : 'Target'}
          onChange={(e) => v.setStrikeText(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          aria-label="Target price"
          style={input}
        />
      </Field>
    </>
  );
}

function FixtureRow({ title, when, opensAt, on, onClick, now }: { title: string; when: string; opensAt: number | null; on: boolean; onClick: () => void; now: number | null }) {
  const notYet = opensAt !== null && now !== null && opensAt > now;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={notYet}
      aria-pressed={on}
      className="wm-row"
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, textAlign: 'left', background: on ? 'var(--raise2)' : 'transparent', boxShadow: on ? 'inset 0 0 0 1.5px var(--mako-canvas-fg)' : 'inset 0 -1px 0 var(--line)', opacity: notYet ? 0.55 : 1, cursor: notYet ? 'not-allowed' : 'pointer' }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {notYet && <span style={{ display: 'block', ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 3 }}>Pools open {dateTime(opensAt!)}</span>}
      </span>
      <span style={{ flex: 'none', ...mono, fontSize: 11, color: 'var(--dim)' }}>{when}</span>
    </button>
  );
}

function FootballChoice(v: ViewProps) {
  return (
    <>
      <Field title="MATCH">
        {v.fixturesError ? (
          <div style={{ fontSize: 14, color: 'var(--mako-red)' }}>Can’t load matches right now. Try again in a moment.</div>
        ) : v.fixtures === null ? (
          <div style={{ fontSize: 14, color: 'var(--dim)' }}>Loading matches…</div>
        ) : v.fixtures.length === 0 ? (
          <div style={{ fontSize: 14, color: 'var(--dim)' }}>No matches in the coming days.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
            {v.fixtures.map((f) => (
              <FixtureRow key={f.id} title={`${f.homeTeam} v ${f.awayTeam}`} when={dateTime(Math.floor(new Date(f.kickoffIso).getTime() / 1000))} opensAt={opensForPoolsAt(f.kickoffIso, 'football')} on={v.fixtureId === f.id} onClick={() => v.setFixtureId(f.id)} now={v.now} />
            ))}
          </div>
        )}
      </Field>
      <Field title="QUESTION TYPE">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {FOOTBALL_QUESTIONS.map((q) => (
            <Pill key={q.key} on={v.footballQ === q.key} onClick={() => v.setFootballQ(q.key)}>
              {q.label}
            </Pill>
          ))}
        </div>
      </Field>
    </>
  );
}

function NbaChoice(v: ViewProps) {
  const total = v.nbaQ === 'over' || v.nbaQ === 'under';
  return (
    <>
      <Field title="GAME">
        {v.gamesError ? (
          <div style={{ fontSize: 14, color: 'var(--mako-red)' }}>Can’t load games right now. Try again in a moment.</div>
        ) : v.games === null ? (
          <div style={{ fontSize: 14, color: 'var(--dim)' }}>Loading games…</div>
        ) : v.games.length === 0 ? (
          <div style={{ fontSize: 14, color: 'var(--dim)' }}>No NBA games in the coming days.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
            {v.games.map((g) => (
              <FixtureRow key={g.id} title={`${g.visitorTeam} @ ${g.homeTeam}`} when={dateTime(Math.floor(new Date(g.tipoffIso).getTime() / 1000))} opensAt={opensForPoolsAt(g.tipoffIso, 'basketball')} on={v.gameId === g.id} onClick={() => v.setGameId(g.id)} now={v.now} />
            ))}
          </div>
        )}
      </Field>
      <Field title="QUESTION TYPE">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {NBA_QUESTIONS.map((q) => (
            <Pill key={q.key} on={v.nbaQ === q.key} onClick={() => v.setNbaQ(q.key)}>
              {q.label}
            </Pill>
          ))}
        </div>
      </Field>
      {total && (
        <Field title="TOTAL POINTS LINE">
          <input value={v.totalText} onChange={(e) => v.setTotalText(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="220.5" aria-label="Total points line" style={input} />
        </Field>
      )}
    </>
  );
}

function YesNo({ market }: { market: MarketWithId }) {
  const rules = poolRules(market);
  const yes = rules.find((r) => r.k === 'YES')?.v;
  const no = rules.find((r) => r.k === 'NO')?.v;
  if (!yes || !no) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 18 }}>
      {[
        ['YES MEANS', yes, 'var(--up-text)'],
        ['NO MEANS', no, 'var(--mako-red)'],
      ].map(([k, text, c]) => (
        <div key={k}>
          <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: c }}>{k}</div>
          <div style={{ marginTop: 8, padding: '12px 14px', borderRadius: 12, background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', fontSize: 14, lineHeight: 1.45 }}>{text}</div>
        </div>
      ))}
    </div>
  );
}

function StepTiming(v: ViewProps) {
  return (
    <>
      {v.priceKind && (
        <Field title="HOW LONG IT RUNS">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {DURATIONS.map((d) => (
              <Pill key={d.seconds} on={v.durationSec === d.seconds} onClick={() => v.setDurationSec(d.seconds)}>
                {d.short}
              </Pill>
            ))}
          </div>
        </Field>
      )}
      {v.market && (
        <div style={{ marginTop: 18 }}>
          {poolRules(v.market)
            .filter((r) => r.k === 'CLOSES' || r.k === 'SOURCE' || r.k === 'REFUND')
            .map((r) => (
              <div key={r.k} style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr)', gap: 14, padding: '11px 0', boxShadow: 'inset 0 -1px 0 var(--line)', fontSize: 14, lineHeight: 1.45 }}>
                <span style={{ ...mono, fontSize: 12, fontWeight: 700 }}>{r.k}</span>
                <span>{r.v}</span>
              </div>
            ))}
          {v.priceKind && <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 10 }}>Times count from the moment you confirm.</div>}
        </div>
      )}
      {v.built && !v.built.ok && (
        <div role="alert" style={{ marginTop: 14, fontSize: 14, color: 'var(--mako-red)' }}>
          {v.built.reason}
        </div>
      )}
    </>
  );
}

function StepReview(v: ViewProps) {
  const p = v.pool!;
  const rows: [string, string][] = [
    ['QUESTION', p.question],
    ['BETTING CLOSES', dayTime(Number(p.bettingCloseTime))],
    ['RESULT AFTER', dayTime(Number(p.closeTime))],
    ['MINIMUM BET', `${usdc2(MIN_BET)} USDC`],
    ['YOUR FEE', '2% of the whole pool, only if it settles YES or NO. It goes to the winners instead if the smaller side is under about 4% of the larger.'],
  ];
  return (
    <>
      <div style={{ marginTop: 18 }}>
        {rows.map(([k, val]) => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: '130px minmax(0,1fr)', gap: 14, padding: '10px 0', boxShadow: 'inset 0 -1px 0 var(--line)', fontSize: 14, lineHeight: 1.45 }}>
            <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>{k}</span>
            <span style={{ fontWeight: k === 'QUESTION' ? 700 : 500 }}>{val}</span>
          </div>
        ))}
      </div>
      <Field title="YOUR FIRST BET · GOES INTO THE POOL, AT LEAST 1 USDC">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={v.seedText} onChange={(e) => v.setSeedText(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" aria-label="Your first bet in USDC" style={{ ...input, flex: 1 }} />
          <Pill on={v.seedYes} tone="yes" onClick={() => v.setSeedYes(true)}>
            YES
          </Pill>
          <Pill on={!v.seedYes} tone="no" onClick={() => v.setSeedYes(false)}>
            NO
          </Pill>
        </div>
      </Field>
      {v.seedProblem && (
        <div role="alert" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.45, padding: '10px 12px', borderRadius: 10, boxShadow: 'inset 0 0 0 1px var(--line)' }}>
          {v.seedProblem}
        </div>
      )}
    </>
  );
}

function StepLive(v: ViewProps) {
  const [copied, setCopied] = useState(false);
  const href = v.createdId !== null ? `/pools/${v.createdId}` : null;
  const url = href && typeof window !== 'undefined' ? `${window.location.origin}${href}` : null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>
        CREATED · ON-CHAIN
        {v.doneTx && (
          <>
            {' · '}
            <a href={explorerUrl('tx', v.doneTx)} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
              {formatAddress(v.doneTx)} ↗
            </a>
          </>
        )}
      </div>
      <h2 style={{ margin: '10px 0 0', ...display, fontSize: 30, letterSpacing: '-0.02em' }}>Your pool is live</h2>
      {url ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, padding: '12px 14px', borderRadius: 12, background: 'var(--raise)' }}>
          <span style={{ flex: 1, minWidth: 0, ...mono, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
            className="mk-press96"
            style={{ flex: 'none', height: 34, padding: '0 14px', borderRadius: 9999, background: 'var(--raise2)', ...mono, fontSize: 12, fontWeight: 700 }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 14, color: 'var(--dim)', marginTop: 12 }}>It shows in Pools within a few seconds.</div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <Link href={href ?? '/pools'} className="mk-press96" style={{ ...primaryButton(true), display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
          {href ? 'View pool' : 'Go to Pools'}
        </Link>
        <button type="button" onClick={v.reset} className="mk-press96" style={{ height: 52, padding: '0 22px', borderRadius: 9999, background: 'var(--raise2)', ...display, fontSize: 17 }}>
          Create another
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Preview and what happens

function Preview({ market }: { market: MarketWithId | null }) {
  const cat = market ? CAT_STYLE[({ [MarketType.CRYPTO]: 'CRYPTO', [MarketType.FOOTBALL]: 'FOOTBALL', [MarketType.BASKETBALL]: 'NBA', [MarketType.FOREX]: 'FOREX', [MarketType.COMMODITIES]: 'COMMODITIES', [MarketType.STOCKS]: 'STOCKS', [MarketType.MAKO]: 'MAKO' } as Record<number, PoolCat>)[market.mType]] : null;
  const yesPct = market && market.totalYes > 0n ? 100 : 0;
  return (
    <div>
      <div style={label}>PREVIEW · HOW IT SHOWS IN POOLS</div>
      <div style={{ marginTop: 10, padding: 16, borderRadius: 16, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {cat && (
            <span aria-hidden="true" style={{ flex: 'none', width: 32, height: 32, borderRadius: 9999, background: cat.bg, color: cat.fg, boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...mono, fontSize: 9, fontWeight: 700 }}>
              {cat.abbr}
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ ...display, fontSize: 17, lineHeight: 1.2, color: market ? 'var(--mako-canvas-fg)' : 'var(--dim)' }}>{market?.question ?? 'Your question shows here'}</div>
            {market && <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 6 }}>1 bettor · by you · closes {dayTime(Number(market.bettingCloseTime))}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', ...mono, fontSize: 12, fontWeight: 700, marginTop: 14 }}>
          <span style={{ color: 'var(--up-text)' }}>YES {yesPct}%</span>
          <span style={{ color: 'var(--mako-red)' }}>{market ? 100 - yesPct : 0}% NO</span>
        </div>
        <div style={{ display: 'flex', height: 4, borderRadius: 9999, overflow: 'hidden', background: market ? 'var(--mako-red)' : 'var(--line)', marginTop: 7 }}>
          <div style={{ width: `${yesPct}%`, background: 'var(--mako-signal)' }} />
        </div>
        <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 12, textAlign: 'center' }}>Payouts show once both sides have bets.</div>
      </div>
    </div>
  );
}

function WhatHappens({ market }: { market: MarketWithId | null }) {
  const source = market ? (poolRules(market).find((r) => r.k === 'SOURCE')?.v ?? '') : '';
  const items: [string, string, string][] = [
    ['var(--mako-signal)', 'Opens', 'as soon as you create it'],
    ['var(--mako-gold)', 'Betting closes', market ? dayTime(Number(market.bettingCloseTime)) : 'at the time shown'],
    ['var(--mako-violet)', 'Result', market ? source.replace(/\.$/, '') : 'from the source shown'],
    ['var(--mako-teal)', 'Winners claim', 'from the pool page or Me'],
  ];
  return (
    <div style={{ marginTop: 18 }}>
      <div style={label}>WHAT HAPPENS</div>
      {items.map(([c, t, s]) => (
        <div key={t} style={{ display: 'flex', gap: 12, padding: '10px 0', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
          <span aria-hidden="true" style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', background: c, marginTop: 6 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{t}</div>
            <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>{s}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Layout

function CreateView(v: ViewProps & { variant: 'desktop' | 'mobile' }) {
  const desktop = v.variant === 'desktop';
  const canContinue = v.step === 1 ? v.pool !== null || (v.built !== null && !v.built.ok && v.priceKind !== null) : v.step === 2 ? v.pool !== null : false;
  const body =
    v.step === 1 ? <StepMarket {...v} /> : v.step === 2 ? <StepTiming {...v} /> : v.step === 3 && v.pool ? <StepReview {...v} /> : v.step === 4 ? <StepLive {...v} /> : <StepMarket {...v} />;
  const actions =
    v.step === 4 ? null : !v.user ? (
      <SignInLink className="mk-press96" style={{ ...primaryButton(true), display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
        Sign in to create a pool
      </SignInLink>
    ) : v.step < 3 ? (
      <button type="button" disabled={!canContinue} onClick={() => v.setStep((v.step + 1) as Step)} className="mk-press96" style={primaryButton(canContinue)}>
        Continue
      </button>
    ) : (
      <button type="button" disabled={!!v.seedProblem || !v.pool} onClick={v.openCreate} className="mk-press96" style={primaryButton(!v.seedProblem && !!v.pool)}>
        Create pool
      </button>
    );
  return (
    <div style={{ padding: desktop ? '0 0 28px' : '0 16px 40px' }}>
      <Link href="/pools" style={{ display: 'inline-block', ...mono, fontSize: 12, color: 'var(--dim)', padding: desktop ? '14px 4px 0' : '8px 0 0', textDecoration: 'none' }}>
        ← POOLS
      </Link>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, padding: desktop ? '8px 4px 18px' : '6px 0 14px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, ...display, fontSize: desktop ? 56 : 34, lineHeight: 1, letterSpacing: '-0.04em' }}>{desktop ? 'Create pool market' : 'Create pool'}</h1>
        {desktop && v.stats && (
          <div style={{ display: 'flex', gap: 22, ...mono, fontSize: 12, paddingBottom: 6 }}>
            <span>
              <span style={{ color: 'var(--dim)' }}>YOUR POOLS</span> <span style={{ fontWeight: 700 }}>{v.stats.pools}</span>
            </span>
            {v.stats.bothSides !== null && (
              <span>
                <span style={{ color: 'var(--dim)' }}>BOTH SIDES FILLED</span> <span style={{ fontWeight: 700 }}>{v.stats.bothSides}%</span>
              </span>
            )}
          </div>
        )}
      </div>
      <Steps step={v.step} />
      <div style={{ display: desktop ? 'grid' : 'block', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 32, marginTop: 18, paddingTop: 4, borderTop: '1px solid var(--line)' }}>
        <div style={{ minWidth: 0 }}>
          {body}
          <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
            {v.step > 1 && v.step < 4 && (
              <button type="button" onClick={() => v.setStep((v.step - 1) as Step)} className="mk-press96" style={{ height: 52, padding: '0 20px', borderRadius: 9999, background: 'var(--raise2)', ...display, fontSize: 17 }}>
                Back
              </button>
            )}
            {actions}
          </div>
        </div>
        {v.step < 4 && (
          <div style={{ marginTop: desktop ? 0 : 28 }}>
            <Preview market={v.market} />
            <WhatHappens market={v.market} />
          </div>
        )}
      </div>
    </div>
  );
}
