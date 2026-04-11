'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useWaitForTransactionReceipt } from 'wagmi';
import { decodeEventLog, type Hex } from 'viem';
import { makoAbi, MarketType } from '@/lib/contract';
import { useCreateMarket } from '@/lib/hooks';
import { toBytes32 } from '@/lib/oracle';

/**
 * /create — two-tab market creation form.
 *
 * Tab 1: CRYPTO — live CoinGecko prices, pick a symbol/direction/strike/duration,
 *        submit encodes `SYMBOL:gt:STRIKE` as bytes32 and fires createMarket(CRYPTO).
 *        Auto-generates the question text. Auto-resolvable via the off-chain resolver.
 *
 * Tab 2: FOOTBALL — upcoming EPL fixtures from football-data.org, pick a match +
 *        question type (HOME WIN / AWAY WIN / DRAW / OVER 2.5), encodes
 *        `{matchId}:type:param` as bytes32, fires createMarket(FOOTBALL).
 *        Auto-resolvable via the off-chain resolver once football support lands.
 *
 * AD-HOC markets have been retired from the create UI. The contract still supports
 * them, but they can't be auto-resolved because the free-form question has no
 * machine-readable oracle payload. Existing on-chain ADHOC markets remain accessible
 * via direct `/market/[id]` URLs and the admin resolve page.
 *
 * Both tabs share the same tx pipeline (useCreateMarket + useWaitForTransactionReceipt
 * + decodeEventLog) and redirect to /market/{id} on success, extracting `id` from the
 * receipt's MarketCreated event so we never have to guess `nextMarketId - 1`.
 */

type Tab = 'crypto' | 'football';
type CryptoSymbol = 'BTC' | 'ETH' | 'SOL' | 'MON';
type Direction = 'above' | 'below';

type FootballFixture = {
  id: number;
  homeTeam: string;
  awayTeam: string;
  kickoffIso: string;
  kickoffLabel: string;
};

type DiscoverFootballResponse = {
  fixtures: FootballFixture[];
  error?: string;
};

type FootballQuestionType = 'home_win' | 'away_win' | 'draw' | 'over';

type CryptoPrice = { usd: number; change24h: number; testnet?: boolean };
type CryptoPrices = {
  btc: CryptoPrice;
  eth: CryptoPrice;
  sol: CryptoPrice;
  mon: CryptoPrice;
  error?: string;
};

type CreateArgs = {
  mType: MarketType;
  oracleRef: Hex;
  closeTime: bigint;
  question: string;
};

const DURATIONS: Array<{ label: string; short: string; seconds: number }> = [
  { label: '30 seconds', short: '30S', seconds: 30 },
  { label: '60 seconds', short: '60S', seconds: 60 },
  { label: '5 minutes', short: '5M', seconds: 300 },
  { label: '10 minutes', short: '10M', seconds: 600 },
  { label: '1 hour', short: '1H', seconds: 3600 },
  { label: '24 hours', short: '24H', seconds: 86400 },
];

export default function CreateMarketPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('crypto');

  // Shared tx lifecycle across both tabs. Submitting from either tab fires
  // the same `create()` hook, so the parent state drives the disable logic
  // and status strip consistently.
  const { create, hash, isPending, error } = useCreateMarket();
  const { data: receipt, isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Derive the decoded new id + any decode error from the receipt using
  // useMemo, NOT via setState inside an effect (react-hooks/set-state-in-effect).
  // The effect below only handles the side effect of navigation.
  const parsedReceipt = useMemo(() => {
    if (!isSuccess || !receipt) return { newId: null as bigint | null, error: null as string | null };
    let newId: bigint | null = null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: makoAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'MarketCreated') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          newId = (decoded.args as any).id as bigint;
          break;
        }
      } catch {
        // not our event, skip silently
      }
    }
    return {
      newId,
      error:
        newId === null
          ? 'TX SUCCEEDED BUT MARKET ID NOT FOUND IN RECEIPT · CHECK EXPLORER'
          : null,
    };
  }, [isSuccess, receipt]);

  const { newId: parsedNewId, error: decodeError } = parsedReceipt;

  // Side effect: navigate to the new market's detail page once the id is decoded.
  // If decoding fails, log a warning but don't setState (the UI already reflects
  // the error via the derived `decodeError` value above).
  useEffect(() => {
    if (parsedNewId !== null) {
      router.push(`/market/${parsedNewId.toString()}`);
    } else if (decodeError && receipt) {
      console.warn('[create] MarketCreated event not found in receipt logs', receipt);
    }
  }, [parsedNewId, decodeError, receipt, router]);

  const handleCreate = async (args: CreateArgs) => {
    try {
      await create(args);
    } catch (e) {
      // error state surfaces via the hook
      console.error('[create] failed:', e);
    }
  };

  const isBusy = isPending || isWaiting;
  const statusText = isPending
    ? 'CONFIRM IN WALLET...'
    : isWaiting
      ? 'CREATING MARKET...'
      : decodeError
        ? decodeError
        : isSuccess
          ? 'MARKET CREATED · REDIRECTING...'
          : error
            ? `ERROR: ${(error as Error).message.slice(0, 100).toUpperCase()}`
            : null;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <div className="px-6 md:px-8 py-4 border-b border-black">
        <Link
          href="/"
          className="text-foreground text-sm font-black uppercase tracking-widest hover:bg-black hover:text-background px-2 py-1 -ml-2 inline-block transition-colors"
        >
          &lt; BACK
        </Link>
      </div>

      <div className="px-6 md:px-8 py-8 border-b border-black">
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          [ NEW MARKET ]
        </div>
        <h1 className="text-3xl font-black uppercase tracking-tight">CREATE</h1>
        <p className="text-muted text-[11px] font-bold uppercase tracking-widest mt-2">
          PICK A SOURCE · BUILD A QUESTION · LAUNCH
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex flex-row divide-x divide-black border-b border-black">
        <button
          type="button"
          onClick={() => setTab('crypto')}
          disabled={isBusy}
          className={`flex-1 py-3 font-black text-xs uppercase tracking-widest transition-colors disabled:opacity-50 ${
            tab === 'crypto' ? 'bg-black text-background' : 'hover:bg-black hover:text-background'
          }`}
        >
          CRYPTO
        </button>
        <button
          type="button"
          onClick={() => setTab('football')}
          disabled={isBusy}
          className={`flex-1 py-3 font-black text-xs uppercase tracking-widest transition-colors disabled:opacity-50 ${
            tab === 'football' ? 'bg-black text-background' : 'hover:bg-black hover:text-background'
          }`}
        >
          FOOTBALL
        </button>
      </div>

      {tab === 'crypto' ? (
        <CryptoTab onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} />
      ) : (
        <FootballTab onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} />
      )}

      {/* Non-busy status line below the submit button */}
      {statusText && !isBusy && (
        <div
          className={`px-4 py-3 text-[10px] font-black uppercase tracking-widest text-center border-t border-black break-words ${
            isSuccess && !decodeError
              ? 'bg-yes/15 text-yes'
              : 'bg-warning/15 text-warning'
          }`}
        >
          {statusText}
        </div>
      )}
    </main>
  );
}

// ======================================================================
// CRYPTO TAB — live CoinGecko prices + strike/direction/duration form
// ======================================================================

type TabProps = {
  onSubmit: (args: CreateArgs) => Promise<void>;
  isBusy: boolean;
  statusText: string | null;
};

function CryptoTab({ onSubmit, isBusy, statusText }: TabProps) {
  const [prices, setPrices] = useState<CryptoPrices | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<CryptoSymbol>('BTC');
  const [direction, setDirection] = useState<Direction>('above');
  const [strikeInput, setStrikeInput] = useState('');
  const [strikeTouched, setStrikeTouched] = useState(false);
  const [durationSec, setDurationSec] = useState(60);

  // Poll CoinGecko (server-proxied) every 10s. Fetch on mount, then interval.
  useEffect(() => {
    let cancelled = false;

    const fetchPrices = async () => {
      try {
        const res = await fetch('/api/discover/crypto', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as CryptoPrices;
        if (!cancelled) setPrices(data);
      } catch (e) {
        console.warn('[crypto-tab] price fetch failed:', e);
      }
    };

    fetchPrices();
    const iv = setInterval(fetchPrices, 10_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  const currentPrice = useMemo(() => {
    if (!prices) return 0;
    if (selectedSymbol === 'BTC') return prices.btc.usd;
    if (selectedSymbol === 'ETH') return prices.eth.usd;
    if (selectedSymbol === 'SOL') return prices.sol.usd;
    return prices.mon.usd;
  }, [prices, selectedSymbol]);

  // Default strike = current price × 1.01 (above) or × 0.99 (below).
  // User can override via strikeInput once they touch the field.
  const defaultStrike = useMemo(() => {
    if (!currentPrice) return 0;
    const mult = direction === 'above' ? 1.01 : 0.99;
    return Math.round(currentPrice * mult);
  }, [currentPrice, direction]);

  const effectiveStrike = useMemo(() => {
    if (!strikeTouched || strikeInput === '') return defaultStrike;
    const parsed = Number(strikeInput);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultStrike;
  }, [strikeTouched, strikeInput, defaultStrike]);

  const autoQuestion = useMemo(() => {
    if (!effectiveStrike) return '';
    const durationLabel =
      DURATIONS.find((d) => d.seconds === durationSec)?.label ?? `${durationSec}s`;
    const dirWord = direction === 'above' ? 'close above' : 'close below';
    return `Will ${selectedSymbol} ${dirWord} $${effectiveStrike.toLocaleString()} in ${durationLabel}?`;
  }, [selectedSymbol, direction, effectiveStrike, durationSec]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveStrike || isBusy) return;

    const op = direction === 'above' ? 'gt' : 'lt';
    const oracleRefStr = `${selectedSymbol}:${op}:${effectiveStrike}`;
    const oracleRef = toBytes32(oracleRefStr);
    const closeTime = BigInt(Math.floor(Date.now() / 1000) + durationSec);

    await onSubmit({
      mType: MarketType.CRYPTO,
      oracleRef,
      closeTime,
      question: autoQuestion,
    });
  };

  const disabled = isBusy || !effectiveStrike;

  return (
    <form onSubmit={handleSubmit} className="flex-1 flex flex-col">
      {/* Live prices */}
      <div className="border-b border-black">
        <div className="px-6 md:px-8 py-3 text-[10px] font-black uppercase tracking-widest text-muted flex justify-between">
          <span>LIVE PRICES · TAP TO SELECT</span>
          <span className="text-subtle">REFRESH 10S</span>
        </div>
        <div className="grid grid-cols-4 divide-x divide-black border-t border-black">
          {(['BTC', 'ETH', 'SOL', 'MON'] as const).map((sym) => {
            const price =
              sym === 'BTC'
                ? prices?.btc
                : sym === 'ETH'
                  ? prices?.eth
                  : sym === 'SOL'
                    ? prices?.sol
                    : prices?.mon;
            const change = price?.change24h ?? 0;
            const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '·';
            const isSelected = selectedSymbol === sym;
            const isTestnet = price?.testnet === true;
            return (
              <button
                key={sym}
                type="button"
                onClick={() => {
                  setSelectedSymbol(sym);
                  setStrikeTouched(false);
                  setStrikeInput('');
                }}
                disabled={isBusy}
                className={`py-5 px-2 flex flex-col items-center justify-center transition-colors disabled:opacity-50 ${
                  isSelected
                    ? 'bg-black text-background'
                    : 'hover:bg-black hover:text-background'
                }`}
              >
                <span className="text-[11px] font-black uppercase tracking-widest mb-1">{sym}</span>
                <span className="text-base font-black tabular-nums">
                  {price
                    ? `$${price.usd.toLocaleString(undefined, { maximumFractionDigits: price.usd < 10 ? 2 : 0 })}`
                    : '—'}
                </span>
                {isTestnet ? (
                  <span
                    className={`text-[8px] font-black tracking-widest mt-1 ${
                      isSelected ? 'opacity-80' : 'text-muted'
                    }`}
                  >
                    TESTNET
                  </span>
                ) : (
                  <span
                    className={`text-[9px] font-black tabular-nums mt-1 ${
                      isSelected ? 'opacity-80' : 'text-muted'
                    }`}
                  >
                    {arrow} {Math.abs(change).toFixed(2)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Direction */}
      <div className="px-6 md:px-8 py-5 border-b border-black">
        <label className="block text-[10px] font-black uppercase tracking-widest text-muted mb-3">
          DIRECTION
        </label>
        <div className="grid grid-cols-2 border border-black divide-x divide-black">
          {(['above', 'below'] as const).map((dir) => (
            <button
              key={dir}
              type="button"
              onClick={() => {
                setDirection(dir);
                setStrikeTouched(false);
                setStrikeInput('');
              }}
              disabled={isBusy}
              className={`py-3 font-black text-xs uppercase tracking-widest transition-colors disabled:opacity-50 ${
                direction === dir
                  ? 'bg-black text-background'
                  : 'hover:bg-black hover:text-background'
              }`}
            >
              {dir === 'above' ? '▲ ABOVE' : '▼ BELOW'}
            </button>
          ))}
        </div>
      </div>

      {/* Strike */}
      <div className="px-6 md:px-8 py-5 border-b border-black">
        <label
          htmlFor="strike"
          className="block text-[10px] font-black uppercase tracking-widest text-muted mb-3"
        >
          STRIKE PRICE (USD)
        </label>
        <div className="flex items-center gap-3 border border-black px-4 py-3">
          <span className="text-xs font-black uppercase tracking-widest text-muted">$</span>
          <input
            id="strike"
            type="text"
            inputMode="decimal"
            value={strikeTouched ? strikeInput : String(defaultStrike || '')}
            onChange={(e) => {
              setStrikeTouched(true);
              setStrikeInput(e.target.value.replace(/[^0-9.]/g, ''));
            }}
            disabled={isBusy}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-2xl font-black tabular-nums text-foreground disabled:opacity-50"
            placeholder={String(defaultStrike || '0')}
          />
        </div>
        <div className="text-[10px] font-black uppercase tracking-widest text-muted mt-2">
          DEFAULT = LIVE PRICE {direction === 'above' ? '× 1.01' : '× 0.99'} · TAP TO EDIT
        </div>
      </div>

      {/* Duration */}
      <div className="px-6 md:px-8 py-5 border-b border-black">
        <label className="block text-[10px] font-black uppercase tracking-widest text-muted mb-3">
          DURATION
        </label>
        <div className="grid grid-cols-6 border border-black divide-x divide-black">
          {DURATIONS.map((d) => (
            <button
              key={d.seconds}
              type="button"
              onClick={() => setDurationSec(d.seconds)}
              disabled={isBusy}
              className={`py-3 font-black text-sm uppercase tracking-widest tabular-nums transition-colors disabled:opacity-50 ${
                durationSec === d.seconds
                  ? 'bg-black text-background'
                  : 'hover:bg-black hover:text-background'
              }`}
            >
              {d.short}
            </button>
          ))}
        </div>
      </div>

      {/* Auto-generated question preview */}
      <div className="px-6 md:px-8 py-5 border-b border-black bg-surface-elevated">
        <label className="block text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          QUESTION (AUTO-GENERATED)
        </label>
        <p className="text-base font-black uppercase tracking-tight leading-tight">
          {autoQuestion || '—'}
        </p>
      </div>

      <div className="flex-1 min-h-[20px]" />

      <button
        type="submit"
        disabled={disabled}
        className={`w-full py-5 border-t border-black font-black uppercase tracking-widest text-sm transition-colors ${
          disabled
            ? 'bg-black/20 text-muted cursor-not-allowed'
            : 'bg-black text-background hover:bg-foreground/90'
        }`}
      >
        {isBusy ? statusText ?? '...' : `[ CREATE ${selectedSymbol} MARKET ]`}
      </button>
    </form>
  );
}

// ======================================================================
// FOOTBALL TAB — EPL fixtures from football-data.org + question builder
// ======================================================================

function FootballTab({ onSubmit, isBusy, statusText }: TabProps) {
  const [fixtures, setFixtures] = useState<FootballFixture[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedFixture, setSelectedFixture] = useState<FootballFixture | null>(null);
  const [questionType, setQuestionType] = useState<FootballQuestionType>('home_win');
  const [durationSec, setDurationSec] = useState(3600); // default 1h for football

  // Fetch fixtures once on mount — football-data.org changes slowly, no poll.
  useEffect(() => {
    let cancelled = false;
    const fetchFixtures = async () => {
      try {
        const res = await fetch('/api/discover/football', { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setFetchError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as DiscoverFootballResponse;
        if (cancelled) return;
        setFixtures(data.fixtures ?? []);
        if (data.error) setFetchError(data.error);
      } catch (e) {
        if (!cancelled) setFetchError((e as Error).message);
      }
    };
    fetchFixtures();
    return () => {
      cancelled = true;
    };
  }, []);

  const autoQuestion = useMemo(() => {
    if (!selectedFixture) return '';
    const { homeTeam, awayTeam } = selectedFixture;
    switch (questionType) {
      case 'home_win':
        return `Will ${homeTeam} beat ${awayTeam}?`;
      case 'away_win':
        return `Will ${awayTeam} beat ${homeTeam}?`;
      case 'draw':
        return `Will ${homeTeam} vs ${awayTeam} end in a draw?`;
      case 'over':
        return `Over 2.5 goals in ${homeTeam} vs ${awayTeam}?`;
    }
  }, [selectedFixture, questionType]);

  const oracleRefStr = useMemo(() => {
    if (!selectedFixture) return '';
    const param = questionType === 'over' ? '2.5' : '0';
    return `${selectedFixture.id}:${questionType}:${param}`;
  }, [selectedFixture, questionType]);

  // Validate oracleRef will fit in bytes32 before trying to encode.
  const oracleRefTooLong = useMemo(() => {
    if (!oracleRefStr) return false;
    return new TextEncoder().encode(oracleRefStr).length > 32;
  }, [oracleRefStr]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFixture || isBusy || oracleRefTooLong) return;

    const oracleRef = toBytes32(oracleRefStr);
    const closeTime = BigInt(Math.floor(Date.now() / 1000) + durationSec);

    await onSubmit({
      mType: MarketType.FOOTBALL,
      oracleRef,
      closeTime,
      question: autoQuestion,
    });
  };

  const disabled = isBusy || !selectedFixture || oracleRefTooLong;

  return (
    <form onSubmit={handleSubmit} className="flex-1 flex flex-col">
      {/* Fixture list */}
      <div className="border-b border-black">
        <div className="px-6 md:px-8 py-3 text-[10px] font-black uppercase tracking-widest text-muted flex justify-between">
          <span>UPCOMING · PREMIER LEAGUE</span>
          <span className="text-subtle">TAP TO SELECT</span>
        </div>
        {fixtures === null ? (
          <div className="py-12 text-center font-black uppercase tracking-widest text-muted text-sm border-t border-black">
            LOADING FIXTURES…
          </div>
        ) : fixtures.length === 0 ? (
          <div className="py-12 text-center border-t border-black px-6">
            <div className="font-black uppercase tracking-widest text-muted text-sm mb-3">
              NO FIXTURES AVAILABLE
            </div>
            {fetchError && (
              <div className="text-[10px] font-black text-subtle tracking-widest break-words max-w-xs mx-auto leading-relaxed">
                {fetchError.slice(0, 180)}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-black border-t border-black">
            {fixtures.map((f) => {
              const isSelected = selectedFixture?.id === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedFixture(f)}
                  disabled={isBusy}
                  className={`py-4 px-6 md:px-8 flex flex-col items-start text-left transition-colors disabled:opacity-50 ${
                    isSelected
                      ? 'bg-black text-background'
                      : 'hover:bg-black hover:text-background'
                  }`}
                >
                  <span className="text-base font-black uppercase tracking-tight leading-tight">
                    {f.homeTeam} VS {f.awayTeam}
                  </span>
                  <span
                    className={`text-[10px] font-black uppercase tracking-widest mt-1 ${
                      isSelected ? 'opacity-80' : 'text-muted'
                    }`}
                  >
                    KICKOFF · {f.kickoffLabel}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Question type — 2x2 grid */}
      <div className="px-6 md:px-8 py-5 border-b border-black">
        <label className="block text-[10px] font-black uppercase tracking-widest text-muted mb-3">
          QUESTION TYPE
        </label>
        <div className="grid grid-cols-2 border border-black divide-x divide-y divide-black">
          {(
            [
              { key: 'home_win' as const, label: 'HOME WIN' },
              { key: 'away_win' as const, label: 'AWAY WIN' },
              { key: 'draw' as const, label: 'DRAW' },
              { key: 'over' as const, label: 'OVER 2.5' },
            ]
          ).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setQuestionType(key)}
              disabled={isBusy}
              className={`py-3 font-black text-xs uppercase tracking-widest transition-colors disabled:opacity-50 ${
                questionType === key
                  ? 'bg-black text-background'
                  : 'hover:bg-black hover:text-background'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Duration */}
      <div className="px-6 md:px-8 py-5 border-b border-black">
        <label className="block text-[10px] font-black uppercase tracking-widest text-muted mb-3">
          DURATION
        </label>
        <div className="grid grid-cols-6 border border-black divide-x divide-black">
          {DURATIONS.map((d) => (
            <button
              key={d.seconds}
              type="button"
              onClick={() => setDurationSec(d.seconds)}
              disabled={isBusy}
              className={`py-3 font-black text-sm uppercase tracking-widest tabular-nums transition-colors disabled:opacity-50 ${
                durationSec === d.seconds
                  ? 'bg-black text-background'
                  : 'hover:bg-black hover:text-background'
              }`}
            >
              {d.short}
            </button>
          ))}
        </div>
      </div>

      {/* Auto-question preview */}
      <div className="px-6 md:px-8 py-5 border-b border-black bg-surface-elevated">
        <label className="block text-[10px] font-black uppercase tracking-widest text-muted mb-2">
          QUESTION (AUTO-GENERATED)
        </label>
        <p className="text-base font-black uppercase tracking-tight leading-tight">
          {autoQuestion || '—'}
        </p>
        {oracleRefTooLong && (
          <p className="text-[10px] font-black text-warning tracking-widest uppercase mt-2">
            ORACLE REF TOO LONG ({oracleRefStr.length} BYTES) · MAX 32 · PICK SHORTER QUESTION TYPE
          </p>
        )}
      </div>

      <div className="flex-1 min-h-[20px]" />

      <button
        type="submit"
        disabled={disabled}
        className={`w-full py-5 border-t border-black font-black uppercase tracking-widest text-sm transition-colors ${
          disabled
            ? 'bg-black/20 text-muted cursor-not-allowed'
            : 'bg-black text-background hover:bg-foreground/90'
        }`}
      >
        {isBusy ? statusText ?? '...' : '[ CREATE FOOTBALL MARKET ]'}
      </button>
    </form>
  );
}

// AD-HOC tab retired: removed from create UI because ADHOC markets can't be
// auto-resolved (no structured oracle payload). Contract still supports them;
// existing on-chain ADHOC markets remain accessible via /market/[id] and
// /admin/resolve for manual cleanup.
