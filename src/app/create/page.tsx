'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { type Hex } from 'viem';
import { decodeMarketCreatedId, MarketType } from '@/lib/contract';
import {
  useCreateMarket,
  useCreatorCreatesToday,
  type CreateMarketResult,
} from '@/lib/hooks';
import { useUser } from '@/lib/use-user';
import { MIN_CREATOR_SEED_USDC_BASE } from '@/lib/aa-constants';
import { parseUsdc, formatUsdc } from '@/lib/usdc';
import { isWalletDrifted } from '@/lib/wallet-drift';
import { WalletDriftBanner } from '@/components/WalletDriftBanner';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MobileChromeHeader } from '@/components/MobileChromeHeader';
import { HoverRevealPicker } from '@/components/HoverRevealPicker';
import { toBytes32 } from '@/lib/oracle';
import { humanizeUntil } from '@/lib/time';
import {
  FOOTBALL_DURATION_SEC,
  BASKETBALL_DURATION_SEC,
  MAX_DURATION_SEC,
  TX_LANDING_BUFFER_SEC,
  sportsTimestamps,
  suggestedCryptoBettingCloseTimeMirror,
  validateMarketTimestamps,
} from '@/lib/market-timing';
import {
  CRYPTO_ASSETS,
  roundStrike,
  formatStrikeForDisplay,
  formatPriceUsd,
  type CryptoSymbol,
} from '@/lib/crypto-assets';
import { getAssetsByClass } from '@/lib/price-feed-assets';

/**
 * /create -- six-tab market creation form (one per publicly-creatable
 * contract MarketType).
 *
 * Tab 1: CRYPTO -- live CoinGecko prices. Encodes `SYMBOL:gt:STRIKE` in bytes32.
 * Tab 2: FOOTBALL -- EPL fixtures via football-data.org.
 * Tab 3: BASKETBALL -- NBA games via balldontlie. home/away win + over/under total points.
 * Tab 4-6: FOREX / COMMODITIES / STOCKS -- same on-chain shape as CRYPTO
 *   (strike + direction + duration). Rendered by PriceFeedTab keyed on `kind`.
 *   Resolution wired via Pyth Hermes in the cf-worker (#180); live
 *   price grid per asset class is deferred to a follow-up phase.
 *
 * The contract's 7th market type, MAKO, is admin-curated and is NOT
 * surfaced here. Its create form lives at /admin/create-mako, behind
 * the admin gate. The on-chain `onlyOwner` modifier on createMarket
 * for MAKO is the authoritative gate; the UI separation just keeps the
 * non-admin /create surface clean.
 *
 * v4 takes TWO timestamps per market:
 *   - `bettingCloseTime` is when placeBet stops (sports: kickoff - 10 min;
 *     crypto: per the contract's tier rule via market-timing mirror).
 *   - `closeTime` is when resolveMarket becomes legal (sports: event end +
 *     duration buffer; crypto: the user-picked evaluation moment).
 *
 * Do NOT thread the same timestamp into both args (the v3 model). Sports
 * markets would become legally resolvable before the event ends.
 */
type Tab =
  | 'crypto'
  | 'football'
  | 'basketball'
  | 'forex'
  | 'commodities'
  | 'stocks';
type Direction = 'above' | 'below';

/**
 * Map known viem / wagmi write errors to plain-English UI strings.
 *
 * The default viem message for a failed wallet request reads like
 * "Requested resource not available. Request arguments: from: 0x..."
 * which is useless to a user. This mapper catches the common cases we
 * can actually help with (wrong chain, rejection, low balance) and
 * falls through to a trimmed raw message otherwise.
 */
function friendlyWriteError(e: Error): string {
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('switch your wallet to monad')) {
    // Thrown by useEnsureMonadChain when the user declined the switch.
    return 'SWITCH WALLET TO MONAD TESTNET';
  }
  if (msg.includes('user rejected') || msg.includes('user denied')) {
    return 'REJECTED IN WALLET';
  }
  if (msg.includes('insufficient funds')) {
    return 'INSUFFICIENT MON BALANCE';
  }
  if (
    msg.includes('requested resource not available')
    || msg.includes('unsupported chain')
    || msg.includes('chain mismatch')
  ) {
    return 'SWITCH WALLET TO MONAD TESTNET';
  }
  return `ERROR: ${e.message.slice(0, 100).toUpperCase()}`;
}

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

type BasketballGame = {
  id: number;
  homeTeam: string;
  visitorTeam: string;
  tipoffIso: string;
  tipoffLabel: string;
};

type DiscoverBasketballResponse = {
  games: BasketballGame[];
  error?: string;
};

type BasketballQuestionType = 'home_win' | 'away_win' | 'over' | 'under';

type CryptoPrice = { usd: number; change24h: number; testnet?: boolean };
type CryptoPrices = Partial<Record<CryptoSymbol, CryptoPrice>>;

type CreateArgs = {
  mType: MarketType;
  oracleRef: Hex;
  bettingCloseTime: bigint;
  closeTime: bigint;
  question: string;
  /** Creator's bundled first bet, in USDC base units. The v4 contract
   *  requires `creatorSeed >= MIN_CREATOR_SEED` (1 USDC) for all
   *  publicly-creatable market types. */
  creatorSeed: bigint;
  /** Side the creator is seeding on. Ignored when creatorSeed === 0n. */
  creatorYes: boolean;
};

const SEED_SIDES: Array<{ key: 'yes' | 'no'; label: string }> = [
  { key: 'yes', label: 'YES' },
  { key: 'no', label: 'NO' },
];

/**
 * Parse a human-typed seed amount into USDC base units.
 *
 * Returns the parsed bigint, or `null` if the input is empty, malformed,
 * or below the contract minimum. Used by every tab to gate its
 * submit button and disable when the seed is invalid. parseUsdc throws
 * on garbage input ("1.2.3", "abc"); we catch that here so callers get a
 * uniform `null` rather than a thrown exception.
 */
function parseCreatorSeed(human: string): bigint | null {
  const trimmed = human.trim();
  if (!trimmed) return null;
  try {
    const base = parseUsdc(trimmed);
    if (base < MIN_CREATOR_SEED_USDC_BASE) return null;
    return base;
  } catch {
    return null;
  }
}

/**
 * Shared seed input + YES/NO side toggle. Rendered by every tab as its
 * final block before the submit button. The contract treats
 * `creatorSeed` as the creator's first bet — it goes into the pool and
 * is claimable like any other bet at resolution, not a fee. The copy
 * here is deliberately phrased that way so users don't read it as a
 * tax.
 */
function CreatorSeedBlock({
  seedInput,
  setSeedInput,
  side,
  setSide,
  isBusy,
}: {
  seedInput: string;
  setSeedInput: (s: string) => void;
  side: 'yes' | 'no';
  setSide: (s: 'yes' | 'no') => void;
  isBusy: boolean;
}) {
  const parsed = parseCreatorSeed(seedInput);
  const seedTooSmall = seedInput.trim() !== '' && parsed === null;
  const minLabel = formatUsdc(MIN_CREATOR_SEED_USDC_BASE);

  // Codex r1 4d-2 MINOR: reject the keystroke rather than stripping
  // invalid chars. The old `replace(/[^0-9.]/g, '')` would silently
  // transform a pasted "1e3" into "13" (a different amount). The
  // strict-decimal regex below accepts empty / "1" / "1." / "1.25"
  // and rejects everything else, so a bad paste is visibly refused
  // instead of mutating into the wrong number.
  const onSeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    if (next === '' || /^\d*(?:\.\d*)?$/.test(next)) {
      setSeedInput(next);
    }
  };

  return (
    <div className="px-6 py-5 border-b-2 border-ink">
      <label htmlFor="creator-seed" className="mako-label text-muted mb-3 block">
        YOUR FIRST BET (USDC)
      </label>
      <div className="flex items-center gap-3 border-2 border-ink rounded-xl px-4 py-3 bg-paper">
        <span className="mako-label text-muted">$</span>
        <input
          id="creator-seed"
          type="text"
          inputMode="decimal"
          value={seedInput}
          onChange={onSeedChange}
          disabled={isBusy}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none mako-display text-2xl tabular-nums disabled:opacity-50"
          placeholder={minLabel}
        />
      </div>
      <div
        className={`mako-label mt-2 tabular-nums ${
          seedTooSmall ? 'text-mako-red' : 'text-muted'
        }`}
      >
        {seedTooSmall
          ? `MINIMUM ${minLabel} USDC * GOES INTO THE POOL * CLAIMABLE AT RESOLUTION`
          : `MINIMUM ${minLabel} USDC * GOES INTO THE POOL AS YOUR FIRST BET`}
      </div>

      <label className="mako-label text-muted mt-5 mb-3 block">YOUR SIDE</label>
      <div className="grid grid-cols-2 gap-3">
        {SEED_SIDES.map(({ key, label }) => {
          const isActive = side === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSide(key)}
              disabled={isBusy}
              aria-pressed={isActive}
              className={`py-3 mako-label rounded-xl border-2 border-ink transition-all disabled:opacity-50 ${
                isActive
                  ? 'bg-ink text-paper shadow-brutal-red -translate-y-[2px] -translate-x-[2px]'
                  : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Crypto-only duration presets. 5 minutes is the floor (below that the
// window is too narrow for spot to move meaningfully). 7 days is the
// ceiling set by MAX_DURATION in MakoMarketsV4.sol. Football/NBA markets
// don't use this. Their (bettingCloseTime, closeTime) split is derived
// from kickoff/tipoff via sportsTimestamps.
const DURATIONS: Array<{ label: string; short: string; seconds: number }> = [
  { label: '5 minutes', short: '5M', seconds: 300 },
  { label: '10 minutes', short: '10M', seconds: 600 },
  { label: '1 hour', short: '1H', seconds: 3600 },
  { label: '6 hours', short: '6H', seconds: 21600 },
  { label: '12 hours', short: '12H', seconds: 43200 },
  { label: '24 hours', short: '24H', seconds: 86400 },
  { label: '3 days', short: '3D', seconds: 259200 },
  { label: '7 days', short: '7D', seconds: 604800 },
];

function isTab(s: string | null): s is Tab {
  return (
    s === 'crypto'
    || s === 'football'
    || s === 'basketball'
    || s === 'forex'
    || s === 'commodities'
    || s === 'stocks'
  );
}

export default function CreateMarketPage() {
  const router = useRouter();
  // Tab is URL-driven so the HoverRevealPicker deep-links land on the
  // correct form. ?tab=crypto|football|basketball. NULL when no tab is
  // selected yet — in that case the form below the picker is not
  // rendered; the user sees only the parent cards + hover-reveal
  // children. The search-param read is reactive: clicking a child Link
  // updates the URL and re-renders with the new tab.
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab | null = isTab(tabParam) ? tabParam : null;

  // Shared tx lifecycle across both tabs. Submitting from either tab fires
  // the same `create()` hook, so the parent state drives the disable logic
  // and status strip consistently.
  //
  // Phase 1H: useCreateMarket branches on auth method internally. Magic
  // users → AA flow (one signature, gas sponsored), wallet users →
  // unchanged wagmi 2-tx flow. The hook returns a discriminated
  // `CreateMarketResult` union from `create()`:
  //   - 'created'           — Magic happy path; hook decoded newId itself
  //   - 'wallet_submitted'  — wallet path; useWaitForTransactionReceipt
  //                            below drives the redirect
  //   - 'submitted'         — Magic bundler accepted, receipt pending
  //   - 'decode_pending'    — Magic tx landed, RPC visibility lag
  //   - 'decode_failed'     — receipt landed, MarketCreated not present
  //   - 'reverted'          — Magic on-chain revert
  //   - 'error'             — sponsor / send / network error
  const { create, hash, isPending, error, flow } = useCreateMarket();
  const { data: receipt, isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Wallet-session drift gate (plan step 23). Computed once at the
  // page top and threaded through to every tab via TabProps. The
  // page-level WalletDriftBanner renders below the tab strip when
  // drifted; the per-tab CREATE submit handler + disabled predicate
  // each enforce `|| drifted` independently so a programmatic submit
  // (e.g. enter-key on a stale field) cannot bypass the visible
  // disabled affordance.
  const { user } = useUser();
  const { address: connectedWallet } = useAccount();
  const drifted = isWalletDrifted(user ?? null, connectedWallet);

  // Daily creator-create cap (slice 4f). The on-chain contract caps
  // public `createMarket` calls at 10 per UTC day per wallet. Mirror
  // it here so the submit button can disable and a counter can render
  // before the user even attempts. Read on whichever identity will
  // actually call createMarket: Magic → safeAddress, wallet → connected
  // wallet. MAKO is admin-only and lives on /admin/create-mako (no
  // counter there — admin path is contract-exempt).
  const capCreator: `0x${string}` | undefined =
    user?.authType === 'magic'
      ? (user.safeAddress as `0x${string}`)
      : user?.authType === 'wallet'
        ? connectedWallet ?? undefined
        : undefined;
  const { data: createsTodayData, refetch: refetchCreatesToday } =
    useCreatorCreatesToday(capCreator);
  const createsToday = createsTodayData
    ? Number((createsTodayData as readonly [bigint, bigint])[0])
    : null;
  const dailyCapHit = createsToday !== null && createsToday >= 10;

  // For the wallet path: derive the decoded new id from the receipt
  // (same as 1C). The Magic path resolves `create()` with newId
  // already decoded, so this only fires for `flow === 'wallet'`.
  const parsedReceipt = useMemo(() => {
    if (!isSuccess || !receipt) return { newId: null as bigint | null, error: null as string | null };
    const newId = decodeMarketCreatedId(receipt);
    return {
      newId,
      error:
        newId === null
          ? 'TX SUCCEEDED BUT MARKET ID NOT FOUND IN RECEIPT * CHECK EXPLORER'
          : null,
    };
  }, [isSuccess, receipt]);

  const { newId: parsedNewId, error: decodeError } = parsedReceipt;

  // Wallet-flow side effect: navigate once the receipt decodes.
  useEffect(() => {
    if (parsedNewId !== null) {
      router.push(`/market/${parsedNewId.toString()}`);
    } else if (decodeError && receipt) {
      console.warn('[create] MarketCreated event not found in receipt logs', receipt);
    }
  }, [parsedNewId, decodeError, receipt, router]);

  const [magicStatusBanner, setMagicStatusBanner] = useState<string | null>(null);

  const handleCreate = async (args: CreateArgs) => {
    try {
      // Each tab owns its own seed input + side toggle and passes them
      // through `args`. MAKO is admin-only and lives on
      // /admin/create-mako; this handler only services the public
      // tabs, which all require a non-zero creator seed.
      const result: CreateMarketResult = await create(args);
      // Slice 4f: refetch the creator-creates-today view on any outcome
      // that may have advanced the counter on-chain. The contract
      // increments on every public create; checking on every non-error
      // outcome covers the wallet-flow case where we lack a synchronous
      // newId. The view is cheap (single 32-byte SSTORE).
      if (result.kind !== 'error' && result.kind !== 'reverted') {
        refetchCreatesToday();
      }
      switch (result.kind) {
        case 'created':
          // Magic happy path — hook decoded newId; redirect.
          setMagicStatusBanner(null);
          router.push(`/market/${result.newId.toString()}`);
          return;
        case 'wallet_submitted':
          // Wallet path — useWaitForTransactionReceipt drives the
          // existing redirect via the useEffect above.
          setMagicStatusBanner(null);
          return;
        case 'submitted':
          // Round-8 MINOR 3 + sub-F MAJOR 2: bundler accepted but the
          // server-side receipt poll didn't confirm in 90s. /me only
          // surfaces markets the user has bet positions in — a creator
          // who hasn't bet won't see their market there. Point them at
          // the home feed instead, where the market appears once the
          // cron resolver-settled tx is indexed.
          setMagicStatusBanner(
            'MARKET SUBMITTED * REFRESH THE HOME FEED IN A FEW MINUTES TO SEE IT',
          );
          return;
        case 'decode_pending':
          setMagicStatusBanner(
            'TX LANDED * REFRESH THE HOME FEED IN A MOMENT TO SEE YOUR MARKET',
          );
          return;
        case 'decode_failed':
          setMagicStatusBanner(
            'TX SUBMITTED BUT MARKET ID NOT FOUND * REFRESH THE HOME FEED OR CHECK EXPLORER',
          );
          return;
        case 'reverted':
          setMagicStatusBanner(`MARKET CREATION REVERTED * ${result.reason.toUpperCase()}`);
          return;
        case 'error':
          // Round-8 MAJOR 2: wallet-branch failures (e.g.
          // ensureChain rejection) reach here without setting
          // hook.error. Surface result.message in the banner so
          // the user always sees the failure reason. Magic-branch
          // 'error' results redundantly set hook.error too — both
          // paths converge on a visible status string.
          setMagicStatusBanner(
            `ERROR: ${result.message.slice(0, 100).toUpperCase()}`,
          );
          return;
      }
    } catch (e) {
      // error state surfaces via the hook
      console.error('[create] failed:', e);
    }
  };

  const isBusy = isPending || isWaiting;
  const statusText = magicStatusBanner
    ? magicStatusBanner
    : isPending
      ? flow === 'loading'
        ? 'CHECKING SIGN-IN...'
        : flow === 'magic'
          ? 'AWAITING SIGNATURE...'
          : 'CONFIRM IN WALLET...'
      : isWaiting
        ? 'CREATING MARKET...'
        : decodeError
          ? decodeError
          : isSuccess
            ? 'MARKET CREATED * REDIRECTING...'
            : error
              ? friendlyWriteError(error as Error)
              : null;

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <MobileChromeHeader />
      {/* Sticky chrome header — matches the home page LIVE MARKETS bar.
          Title condenses NEW MARKET / CREATE / tagline trio into a single
          NEW MARKET label; the tagline reappears on mobile only. */}
      <header className="hidden md:flex items-center justify-between px-6 lg:px-8 h-12 border-b-2 border-chrome-divider bg-chrome text-chrome-fg sticky top-0 z-30">
        <h1 className="mako-display text-sm lg:text-base text-chrome-fg">NEW MARKET</h1>
        <ThemeToggle />
      </header>

      {/* Picker + hero — only render BEFORE a tab is selected. Once a
          child is clicked the URL gains ?tab=..., the picker disappears,
          and the form below takes the full viewport. Picking another
          type means navigating back to /create (sidebar +, or browser
          back). This mirrors the "new page per selection" feel Joshua
          asked for without spawning real new routes. */}
      {tab === null && (
        <div className="px-4 sm:px-6 lg:px-8 pt-6 md:pt-10 max-w-7xl mx-auto w-full">
          <div className="mb-12 text-center flex flex-col items-center">
            <h1 className="font-display font-black text-6xl md:text-[7rem] mb-6 text-canvas-fg tracking-tighter max-w-5xl mx-auto leading-none">
              Monetize your hot takes.
            </h1>
            <p className="font-sans text-canvas-fg text-lg md:text-2xl max-w-3xl mx-auto font-medium leading-snug">
              Finally, a place to weaponize your unsolicited opinions. Create a market, invite your friends, and get paid to be right. Or lose it all trying.
            </p>
          </div>
          <HoverRevealPicker className="mb-6" />
        </div>
      )}

      <div className="px-4 sm:px-6 lg:px-8 pt-6 md:pt-10 pb-6 md:pb-10 max-w-[1400px] mx-auto w-full flex flex-col items-center">
        {/* Page-level wallet-drift banner (plan step 23). Renders ONLY
            when a wallet-authed session no longer matches the connected
            wallet — see `isWalletDrifted`. One banner, regardless of
            which tab is active. */}
        {drifted && user?.authType === 'wallet' && connectedWallet && (
          <div className="mb-6 w-full max-w-2xl">
            <WalletDriftBanner
              sessionWallet={user.walletAddress}
              connectedWallet={connectedWallet}
            />
          </div>
        )}

        {/* Daily cap counter (slice 4f). Renders when the wallet has a
            known count. The submit-side gate is enforced per-tab via
            `dailyCapHit`; this just surfaces the count so the user
            understands why the button greys out at 10. */}
        {capCreator && createsToday !== null && tab !== null && (
          <div
            className={`mb-6 w-full max-w-2xl px-4 py-3 mako-label rounded-xl border-2 flex items-center justify-between ${
              dailyCapHit
                ? 'bg-mako-red/15 text-mako-red border-mako-red'
                : 'bg-surface-elevated text-ink border-ink'
            }`}
          >
            <span>
              CREATES TODAY: {createsToday}/10
            </span>
            <span className="text-[10px] opacity-70">
              {dailyCapHit ? 'CAP REACHED * RESETS AT UTC MIDNIGHT' : 'PER UTC DAY'}
            </span>
          </div>
        )}

        {tab !== null && (
          <div className="w-full flex flex-col lg:flex-row gap-8 lg:gap-12 mb-12 items-start justify-center">

            {/* EDITORIAL INFO BLOCK - NO BOXES */}
            <div className="w-full lg:w-[380px] shrink-0 flex flex-col order-1 lg:order-2 lg:sticky lg:top-24 mt-2 lg:mt-0">
              <div className="mb-12">
                <Link
                  href="/create"
                  className="inline-flex items-center gap-1 mako-label text-canvas-fg/70 hover:text-link-hover transition-colors mb-6"
                >
                  ← CHANGE MARKET TYPE
                </Link>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-3 h-3 bg-mako-red rounded-full animate-pulse shadow-[0_0_8px_rgba(217,74,61,0.6)]"></div>
                  <span className="font-mono text-xs tracking-[0.2em] uppercase opacity-60 text-canvas-fg">Market Spec</span>
                </div>
                <h2 className="font-display font-black text-6xl xl:text-7xl uppercase tracking-tighter leading-[0.85] mb-6 text-canvas-fg">
                  {tab === 'crypto' && <>CRYPTO<br/>MARKET</>}
                  {tab === 'football' && <>FOOTBALL<br/>MARKET</>}
                  {tab === 'basketball' && <>NBA<br/>MARKET</>}
                  {tab === 'forex' && <>FOREX<br/>MARKET</>}
                  {tab === 'commodities' && <>COMMODITIES<br/>MARKET</>}
                  {tab === 'stocks' && <>STOCKS<br/>MARKET</>}
                </h2>
                <p className="font-sans font-medium text-lg text-canvas-fg/70 leading-relaxed border-l-4 border-mako-red pl-5 py-1">
                  {tab === 'crypto' && 'Live token prices. Pick a strike, a direction, and a duration. Lives as short as 5 minutes.'}
                  {tab === 'football' && 'EPL fixtures. Pick home, draw, away, or a total-goals over/under.'}
                  {tab === 'basketball' && 'NBA games. Pick home or away win, or a total-points over/under.'}
                  {tab === 'forex' && 'FX pairs (EUR/USD, GBP/USD, USD/JPY). Same shape as crypto: strike, direction, duration.'}
                  {tab === 'commodities' && 'Precious metals (gold, silver, platinum). Pick a price level and a settlement window.'}
                  {tab === 'stocks' && 'Single-name equities (AAPL, NVDA, TSLA). Same shape as crypto: strike, direction, duration.'}
                </p>
              </div>

              {/* Steps - No Boxes */}
              <div className="flex flex-col gap-10">
                {(tab === 'crypto' ? [
                  { title: "ASSET", desc: "Select a live crypto feed." },
                  { title: "STRIKE", desc: "Set the target price." },
                  { title: "DIRECTION", desc: "Will it settle above or below?" }
                ] : tab === 'football' ? [
                  { title: "FIXTURE", desc: "Select an upcoming EPL match." },
                  { title: "OUTCOME", desc: "Pick the winning side or total goals." },
                  { title: "TIMING", desc: "Automatically settles after the match." }
                ] : tab === 'basketball' ? [
                  { title: "GAME", desc: "Select an upcoming NBA game." },
                  { title: "OUTCOME", desc: "Pick the winning side or total points." },
                  { title: "TIMING", desc: "Automatically settles after the game." }
                ] : tab === 'forex' ? [
                  { title: "PAIR", desc: "Pick an FX pair (EUR/USD, GBP/USD, USD/JPY...)." },
                  { title: "STRIKE", desc: "Set the target exchange rate." },
                  { title: "DIRECTION", desc: "Will it settle above or below?" }
                ] : tab === 'commodities' ? [
                  { title: "ASSET", desc: "Pick a metal (XAU/USD gold, XAG/USD silver, XPT/USD platinum)." },
                  { title: "STRIKE", desc: "Set the target spot price." },
                  { title: "DIRECTION", desc: "Will it settle above or below?" }
                ] : [
                  // stocks (default — all remaining tabs share the strike/direction shape)
                  { title: "TICKER", desc: "Pick an equity ticker (AAPL, NVDA, TSLA...)." },
                  { title: "STRIKE", desc: "Set the target close price." },
                  { title: "DIRECTION", desc: "Will it settle above or below?" }
                ]).map((step, i) => (
                  <div key={i} className="flex items-start gap-6 group">
                    <div className="text-6xl font-display font-black text-canvas-fg/10 group-hover:text-mako-red transition-colors select-none -mt-3">
                      0{i + 1}
                    </div>
                    <div className="pt-1">
                      <div className="font-display font-black text-2xl uppercase tracking-tight mb-2 text-canvas-fg group-hover:text-mako-red transition-colors">
                        {step.title}
                      </div>
                      <div className="font-sans text-base font-medium text-canvas-fg/60">
                        {step.desc}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* FORM CONTAINER */}
            <div className="w-full lg:max-w-2xl flex-1 flex flex-col order-2 lg:order-1">
              <div className="bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden">
                {tab === 'crypto' && <CryptoTab onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} drifted={drifted} dailyCapHit={dailyCapHit} />}
                {tab === 'football' && <FootballTab onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} drifted={drifted} dailyCapHit={dailyCapHit} />}
                {tab === 'basketball' && <BasketballTab onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} drifted={drifted} dailyCapHit={dailyCapHit} />}
                {tab === 'forex' && <PriceFeedTab kind="forex" onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} drifted={drifted} dailyCapHit={dailyCapHit} />}
                {tab === 'commodities' && <PriceFeedTab kind="commodities" onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} drifted={drifted} dailyCapHit={dailyCapHit} />}
                {tab === 'stocks' && <PriceFeedTab kind="stocks" onSubmit={handleCreate} isBusy={isBusy} statusText={statusText} drifted={drifted} dailyCapHit={dailyCapHit} />}
              </div>

              {/* Non-busy status line below the submit button */}
              {statusText && !isBusy && (
                <div
                  className={`mt-4 px-4 py-3 mako-label text-center rounded-xl border-2 break-words ${
                    isSuccess && !decodeError
                      ? 'bg-signal/30 text-ink border-ink'
                      : 'bg-mako-red/15 text-mako-red border-mako-red'
                  }`}
                >
                  {statusText}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </main>
  );
}

// ======================================================================
// CRYPTO TAB -- live CoinGecko prices + strike/direction/duration form
// ======================================================================

type TabProps = {
  onSubmit: (args: CreateArgs) => Promise<void>;
  isBusy: boolean;
  statusText: string | null;
  // Wallet-session drift gate (plan step 23). Computed at the page top
  // and threaded through to each tab. The hook is intentionally
  // drift-unaware (admin / dev surfaces still need it), so per-tab
  // submit handlers are responsible for the early-return + the disabled
  // predicate.
  drifted: boolean;
  // v4 redeploy (slice 4f): daily creator-create cap mirror. Tabs
  // fold this into their `disabled` predicate so the submit button is
  // greyed out when the wallet has already hit 10 creates today. MAKO
  // is contract-exempt and lives on /admin/create-mako instead.
  dailyCapHit: boolean;
};

function CryptoTab({ onSubmit, isBusy, statusText, drifted, dailyCapHit }: TabProps) {
  const [prices, setPrices] = useState<CryptoPrices | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<CryptoSymbol>('BTC');
  const [direction, setDirection] = useState<Direction>('above');
  const [strikeInput, setStrikeInput] = useState('');
  const [strikeTouched, setStrikeTouched] = useState(false);
  const [durationSec, setDurationSec] = useState(300);
  const [seedInput, setSeedInput] = useState(formatUsdc(MIN_CREATOR_SEED_USDC_BASE));
  const [side, setSide] = useState<'yes' | 'no'>('yes');

  // Wall clock for the bettingCloseTime preview. The contract view
  // `suggestedCryptoBettingCloseTime(createdAt, resolutionTime)` is pure,
  // and the local mirror in `market-timing.ts` produces byte-identical
  // results. We use the mirror so the preview re-renders on every
  // duration / wall-clock tick without an RPC round-trip per change.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(id);
  }, []);

  // Poll CoinGecko (server-proxied) every 10s. Fetch on mount, then interval.
  useEffect(() => {
    let cancelled = false;

    const fetchPrices = async () => {
      try {
        const res = await fetch('/api/discover/crypto', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { prices?: CryptoPrices; error?: string };
        if (!cancelled) setPrices(data.prices ?? {});
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
    return prices[selectedSymbol]?.usd ?? 0;
  }, [prices, selectedSymbol]);

  // Default strike = current price * 1.01 (above) or * 0.99 (below),
  // rounded with asset-scale precision so sub-dollar assets (DOGE, MON)
  // don't collapse to $0. See roundStrike in src/lib/crypto-assets.ts.
  // Same function used by scripts/seed-crypto.mts so UI-created and
  // seeded markets always pass the resolver's `strike > 0` guard.
  const defaultStrike = useMemo(() => {
    if (!currentPrice) return 0;
    const mult = direction === 'above' ? 1.01 : 0.99;
    return roundStrike(currentPrice * mult);
  }, [currentPrice, direction]);

  const effectiveStrike = useMemo(() => {
    if (!strikeTouched || strikeInput === '') return defaultStrike;
    const parsed = Number(strikeInput);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultStrike;
  }, [strikeTouched, strikeInput, defaultStrike]);

  // Reactive (closeTime, bettingCloseTime) preview. Recomputed on every
  // duration / wall-clock change so the displayed bettingCloseTime
  // tracks the current selection and never goes stale.
  const closeTimeSec = nowSec + durationSec;
  const bettingCloseSec = useMemo(
    () => Number(suggestedCryptoBettingCloseTimeMirror(nowSec, closeTimeSec)),
    [nowSec, closeTimeSec],
  );

  const autoQuestion = useMemo(() => {
    if (effectiveStrike <= 0) return '';
    const durationLabel =
      DURATIONS.find((d) => d.seconds === durationSec)?.label ?? `${durationSec}s`;
    const dirWord = direction === 'above' ? 'close above' : 'close below';
    return `Will ${selectedSymbol} ${dirWord} $${formatStrikeForDisplay(effectiveStrike)} in ${durationLabel}?`;
  }, [selectedSymbol, direction, effectiveStrike, durationSec]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Hard stop: never let a strike <= 0 reach createMarket. The resolver
    // rejects such oracleRefs in parseCryptoOracleRef and the market would
    // get stuck until forceRefund. Belt-and-suspenders with the button's
    // `disabled` guard below.
    if (effectiveStrike <= 0 || isBusy || drifted) return;
    const creatorSeed = parseCreatorSeed(seedInput);
    if (creatorSeed === null) return;

    const op = direction === 'above' ? 'gt' : 'lt';
    const oracleRefStr = `${selectedSymbol}:${op}:${effectiveStrike}`;
    const oracleRef = toBytes32(oracleRefStr);

    // Recompute timestamps at submit using the freshest wall clock.
    // Ticking state is only refreshed every 10s. We add TX_LANDING_BUFFER_SEC
    // to the duration so a market picked at the MIN_DURATION floor (5M)
    // doesn't revert with BadDuration when the tx takes a few seconds to
    // mine. The user-visible "5 minutes" question stays honest within
    // the buffer; closeTime ends up at 5min 60s on chain.
    const submitNowSec = Math.floor(Date.now() / 1000);
    // Clamp at MAX_DURATION_SEC - TX_LANDING_BUFFER_SEC so a 7d pick
    // (at the contract's exact MAX) doesn't fail the sponsor's
    // duration_too_long check. Two clocks at play:
    //   - UI uses Date.now() (wall clock, what the user sees).
    //   - Sponsor route validates against the latest Monad block
    //     timestamp (chain clock), which trails wall clock by a few
    //     seconds because the latest mined block is always slightly
    //     in the past.
    // For durations well below MAX (5M..3D), the duration + buffer
    // is comfortably below MAX, so the wall-vs-chain delta doesn't
    // matter. For 7D AT the cap, even a 5s chain-lag pushes
    // (closeTime - chainNow) over MAX → bad_create_timestamps.
    // Subtracting one TX_LANDING_BUFFER_SEC from the clamp gives
    // ~60s of slack, comfortably exceeding typical Monad chain lag.
    // Net UX: a 7D pick becomes 7D - 60s ≈ 6d 23h 59min, which is
    // imperceptible to users.
    const submitCloseSec =
      submitNowSec +
      Math.min(
        durationSec + TX_LANDING_BUFFER_SEC,
        MAX_DURATION_SEC - TX_LANDING_BUFFER_SEC,
      );
    const submitBettingCloseSec = Number(
      suggestedCryptoBettingCloseTimeMirror(submitNowSec, submitCloseSec),
    );

    const closeTime = BigInt(submitCloseSec);
    const bettingCloseTime = BigInt(submitBettingCloseSec);

    const validation = validateMarketTimestamps({
      nowSec: submitNowSec,
      bettingCloseTime,
      closeTime,
    });
    if (validation) {
      console.error('[create-crypto] validation failed:', validation);
      return;
    }

    await onSubmit({
      mType: MarketType.CRYPTO,
      oracleRef,
      bettingCloseTime,
      closeTime,
      question: autoQuestion,
      creatorSeed,
      creatorYes: side === 'yes',
    });
  };

  const disabled =
    isBusy || effectiveStrike <= 0 || drifted || dailyCapHit || parseCreatorSeed(seedInput) === null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col">
      {/* Live prices */}
      <div className="border-b-2 border-ink">
        <div className="px-6 py-3 flex justify-between items-center bg-surface-elevated">
          <span className="mako-label text-muted">LIVE PRICES * TAP TO SELECT</span>
          <span className="mako-label text-subtle">REFRESH 10S</span>
        </div>
        {/* 10 assets laid out 2x5 on mobile and 5-wide x 2 rows on desktop.
            Per-cell border math doesn't survive a column-count change
            across breakpoints — `i % 5` and `i / 5` only describe the
            desktop layout, so on mobile the rules fell on the wrong
            edges and tiles in rows 2-5 were missing their top dividers.
            Using `gap-[2px]` with an `bg-ink` container draws clean
            ink-colored dividers between every cell at any column count;
            cells just need a non-transparent fill so the gaps show
            through as lines. */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-[2px] bg-ink border-t-2 border-ink">
          {[...CRYPTO_ASSETS]
            .sort((a, b) => a.priority - b.priority)
            .map((asset) => {
              const sym = asset.symbol;
              const price = prices?.[sym];
              const change = price?.change24h ?? 0;
              const arrow = change > 0 ? 'UP' : change < 0 ? 'DN' : '*';
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
                      ? 'bg-ink text-paper'
                      : 'bg-paper hover:bg-surface-elevated'
                  }`}
                >
                  <span className="mako-label mb-1">{sym}</span>
                  <span className="mako-display text-base tabular-nums">
                    {price ? formatPriceUsd(price.usd) : '-'}
                  </span>
                  {isTestnet ? (
                    <span
                      className={`mako-label text-[8px] mt-1 ${
                        isSelected ? 'text-paper/70' : 'text-muted'
                      }`}
                    >
                      TESTNET
                    </span>
                  ) : (
                    <span
                      className={`mako-label text-[9px] tabular-nums mt-1 ${
                        isSelected ? 'text-paper/70' : change > 0 ? 'text-ink' : change < 0 ? 'text-mako-red' : 'text-muted'
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
      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">DIRECTION</label>
        <div className="grid grid-cols-2 gap-3">
          {(['above', 'below'] as const).map((dir) => {
            const isActive = direction === dir;
            return (
              <button
                key={dir}
                type="button"
                onClick={() => {
                  setDirection(dir);
                  setStrikeTouched(false);
                  setStrikeInput('');
                }}
                disabled={isBusy}
                aria-pressed={isActive}
                className={`py-3 mako-label rounded-xl border-2 border-ink transition-all disabled:opacity-50 ${
                  isActive
                    ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D] -translate-y-[2px] -translate-x-[2px]'
                    : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
                }`}
              >
                {dir === 'above' ? 'UP / ABOVE' : 'DN / BELOW'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Strike */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label htmlFor="strike" className="mako-label text-muted mb-3 block">
          STRIKE PRICE (USD)
        </label>
        <div className="flex items-center gap-3 border-2 border-ink rounded-xl px-4 py-3 bg-paper">
          <span className="mako-label text-muted">$</span>
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
            className="flex-1 min-w-0 bg-transparent border-0 outline-none mako-display text-2xl tabular-nums disabled:opacity-50"
            placeholder={String(defaultStrike || '0')}
          />
        </div>
        <div className="mako-label text-muted mt-2">
          DEFAULT = LIVE PRICE {direction === 'above' ? 'x 1.01' : 'x 0.99'} * TAP TO EDIT
        </div>
      </div>

      {/* Duration -- 8 presets spanning the contract's MAX_DURATION (7 days) */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">DURATION</label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {DURATIONS.map((d) => {
            const isActive = durationSec === d.seconds;
            return (
              <button
                key={d.seconds}
                type="button"
                onClick={() => setDurationSec(d.seconds)}
                disabled={isBusy}
                aria-pressed={isActive}
                className={`py-2.5 mako-label rounded-lg border-2 border-ink transition-all disabled:opacity-50 tabular-nums ${
                  isActive
                    ? 'bg-ink text-paper shadow-[3px_3px_0_0_#D94A3D] -translate-y-[1px] -translate-x-[1px]'
                    : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px]'
                }`}
              >
                {d.short}
              </button>
            );
          })}
        </div>
        {/* Reactive bettingCloseTime preview. Updates whenever the user
            changes duration or the wall clock ticks. */}
        <div className="mako-label text-muted mt-3 leading-relaxed">
          BETS CLOSE {humanizeUntil(bettingCloseSec - nowSec).toUpperCase()} * RESOLVES {humanizeUntil(closeTimeSec - nowSec).toUpperCase()}
        </div>
        <div className="mako-label text-subtle text-[10px] mt-1 leading-relaxed">
          Betting closes early to stop pile-ons after the price is decided.
        </div>
      </div>

      {/* Auto-generated question preview */}
      <div className="px-6 py-5 border-b-2 border-ink bg-surface-elevated">
        <label className="mako-label text-muted mb-2 block">
          QUESTION (AUTO-GENERATED)
        </label>
        <p className="mako-title text-lg leading-tight">
          {autoQuestion || '-'}
        </p>
      </div>

      <CreatorSeedBlock
        seedInput={seedInput}
        setSeedInput={setSeedInput}
        side={side}
        setSide={setSide}
        isBusy={isBusy}
      />

      <button
        type="submit"
        disabled={disabled}
        className={`w-full py-5 mako-display text-lg uppercase tracking-tight transition-colors ${
          disabled
            ? 'bg-surface-elevated text-muted cursor-not-allowed'
            : 'bg-signal text-ink hover:bg-signal/90'
        }`}
      >
        {isBusy ? statusText ?? '...' : `CREATE ${selectedSymbol} MARKET`}
      </button>
    </form>
  );
}

// ======================================================================
// FOOTBALL TAB -- EPL fixtures from football-data.org + question builder
// ======================================================================

function FootballTab({ onSubmit, isBusy, statusText, drifted, dailyCapHit }: TabProps) {
  const [fixtures, setFixtures] = useState<FootballFixture[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedFixture, setSelectedFixture] = useState<FootballFixture | null>(null);
  const [questionType, setQuestionType] = useState<FootballQuestionType>('home_win');
  const [seedInput, setSeedInput] = useState(formatUsdc(MIN_CREATOR_SEED_USDC_BASE));
  const [side, setSide] = useState<'yes' | 'no'>('yes');
  // Track wall-clock to re-render the "closes in ..." countdown. 10s is tight
  // enough to keep the displayed countdown honest near the cutoff. The real
  // guard against a stale-state race at submit time lives in handleSubmit.
  // See the fresh Date.now() check there.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(id);
  }, []);

  // v4 timestamp split: bettingCloseTime is kickoff - 10 min (existing v3
  // derivation, repurposed). closeTime is kickoff + 150 min so the resolver
  // can fire after FT + extra-time + injury, not 10 min before kickoff.
  const timestamps = useMemo(() => {
    if (!selectedFixture) return null;
    const kickoffMs = new Date(selectedFixture.kickoffIso).getTime();
    if (!Number.isFinite(kickoffMs)) return null; // malformed ISO
    const eventStartSec = Math.floor(kickoffMs / 1000);
    const { bettingCloseTime, closeTime } = sportsTimestamps(eventStartSec, 'football');
    return {
      bettingCloseSec: Number(bettingCloseTime),
      closeSec: Number(closeTime),
      bettingCloseTime,
      closeTime,
    };
  }, [selectedFixture]);

  const closeTooSoon = timestamps !== null && timestamps.bettingCloseSec <= nowSec;
  const tooFarOut =
    timestamps !== null && timestamps.closeSec - nowSec > MAX_DURATION_SEC;

  // Fetch fixtures once on mount. football-data.org changes slowly, no poll.
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
    if (
      !selectedFixture
      || isBusy
      || oracleRefTooLong
      || timestamps === null
      || tooFarOut
      || drifted
    ) {
      return;
    }

    // Fresh wall-clock check. `nowSec` only ticks every 10s.
    const submitNowSec = Math.floor(Date.now() / 1000);
    const validation = validateMarketTimestamps({
      nowSec: submitNowSec,
      bettingCloseTime: timestamps.bettingCloseTime,
      closeTime: timestamps.closeTime,
      strictBettingBeforeClose: true,
    });
    if (validation) {
      console.error('[create-football] validation failed:', validation);
      return;
    }

    const creatorSeed = parseCreatorSeed(seedInput);
    if (creatorSeed === null) return;

    const oracleRef = toBytes32(oracleRefStr);

    await onSubmit({
      mType: MarketType.FOOTBALL,
      oracleRef,
      bettingCloseTime: timestamps.bettingCloseTime,
      closeTime: timestamps.closeTime,
      question: autoQuestion,
      creatorSeed,
      creatorYes: side === 'yes',
    });
  };

  const disabled =
    isBusy
    || !selectedFixture
    || oracleRefTooLong
    || closeTooSoon
    || tooFarOut
    || drifted
    || dailyCapHit
    || parseCreatorSeed(seedInput) === null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col">
      {/* Fixture list */}
      <div className="border-b-2 border-ink">
        <div className="px-6 py-3 flex justify-between items-center bg-surface-elevated">
          <span className="mako-label text-muted">UPCOMING * PREMIER LEAGUE</span>
          <span className="mako-label text-subtle">TAP TO SELECT</span>
        </div>
        {fixtures === null ? (
          <div className="py-12 text-center mako-label text-muted border-t-2 border-ink">
            LOADING FIXTURES...
          </div>
        ) : fixtures.length === 0 ? (
          <div className="py-12 text-center border-t-2 border-ink px-6">
            <div className="mako-label text-muted mb-3">NO FIXTURES AVAILABLE</div>
            {fetchError && (
              <div className="mako-label text-[10px] text-subtle break-words max-w-xs mx-auto leading-relaxed">
                {fetchError.slice(0, 180)}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col divide-y-2 divide-ink border-t-2 border-ink">
            {fixtures.map((f) => {
              const isSelected = selectedFixture?.id === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedFixture(f)}
                  disabled={isBusy}
                  className={`py-4 px-6 flex flex-col items-start text-left transition-colors disabled:opacity-50 ${
                    isSelected
                      ? 'bg-ink text-paper'
                      : 'bg-paper hover:bg-surface-elevated'
                  }`}
                >
                  <span className="mako-title text-base leading-tight">
                    {f.homeTeam} vs {f.awayTeam}
                  </span>
                  <span
                    className={`mako-label mt-1 ${
                      isSelected ? 'text-paper/70' : 'text-muted'
                    }`}
                  >
                    KICKOFF * {f.kickoffLabel}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Question type -- 2x2 grid */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">QUESTION TYPE</label>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              { key: 'home_win' as const, label: 'HOME WIN' },
              { key: 'away_win' as const, label: 'AWAY WIN' },
              { key: 'draw' as const, label: 'DRAW' },
              { key: 'over' as const, label: 'OVER 2.5' },
            ]
          ).map(({ key, label }) => {
            const isActive = questionType === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setQuestionType(key)}
                disabled={isBusy}
                aria-pressed={isActive}
                className={`py-3 mako-label rounded-xl border-2 border-ink transition-all disabled:opacity-50 ${
                  isActive
                    ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D] -translate-y-[2px] -translate-x-[2px]'
                    : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Betting window -- derived from kickoff, NOT user-picked. */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">BETTING WINDOW</label>
        {selectedFixture && timestamps !== null ? (
          <div>
            <div className="mako-display text-base tabular-nums">
              BETS CLOSE * {new Date(timestamps.bettingCloseSec * 1000).toUTCString().replace(' GMT', ' UTC')}
            </div>
            <div
              className={`mako-label mt-1 ${
                closeTooSoon ? 'text-mako-red' : 'text-muted'
              }`}
            >
              {closeTooSoon
                ? 'KICKOFF TOO SOON * PICK A LATER FIXTURE'
                : tooFarOut
                  ? 'EVENT TOO FAR OUT * MARKETS SETTLE WITHIN 7 DAYS'
                  : `${humanizeUntil(timestamps.bettingCloseSec - nowSec)} * RESOLVES ~${Math.round(FOOTBALL_DURATION_SEC / 60)} MIN AFTER KICKOFF`}
            </div>
          </div>
        ) : (
          <div className="mako-label text-subtle">
            SELECT A FIXTURE TO SEE CLOSE TIME
          </div>
        )}
      </div>

      {/* Auto-question preview */}
      <div className="px-6 py-5 border-b-2 border-ink bg-surface-elevated">
        <label className="mako-label text-muted mb-2 block">
          QUESTION (AUTO-GENERATED)
        </label>
        <p className="mako-title text-lg leading-tight">
          {autoQuestion || '-'}
        </p>
        {oracleRefTooLong && (
          <p className="mako-label text-mako-red mt-2">
            ORACLE REF TOO LONG ({oracleRefStr.length} BYTES) * MAX 32 * PICK SHORTER QUESTION TYPE
          </p>
        )}
      </div>

      <CreatorSeedBlock
        seedInput={seedInput}
        setSeedInput={setSeedInput}
        side={side}
        setSide={setSide}
        isBusy={isBusy}
      />

      <button
        type="submit"
        disabled={disabled}
        className={`w-full py-5 mako-display text-lg uppercase tracking-tight transition-colors ${
          disabled
            ? 'bg-surface-elevated text-muted cursor-not-allowed'
            : 'bg-signal text-ink hover:bg-signal/90'
        }`}
      >
        {isBusy ? statusText ?? '...' : 'CREATE FOOTBALL MARKET'}
      </button>
    </form>
  );
}

// ======================================================================
// BASKETBALL TAB -- NBA games from balldontlie + home/away/total points
// ======================================================================

function BasketballTab({ onSubmit, isBusy, statusText, drifted, dailyCapHit }: TabProps) {
  const [games, setGames] = useState<BasketballGame[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedGame, setSelectedGame] = useState<BasketballGame | null>(null);
  const [questionType, setQuestionType] = useState<BasketballQuestionType>('home_win');
  const [totalInput, setTotalInput] = useState<string>('215.5');
  const [seedInput, setSeedInput] = useState(formatUsdc(MIN_CREATOR_SEED_USDC_BASE));
  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(id);
  }, []);

  // v4 timestamp split: bettingCloseTime is tipoff - 10 min. closeTime is
  // tipoff + 180 min so the resolver fires after regulation + OT + breaks.
  const timestamps = useMemo(() => {
    if (!selectedGame) return null;
    const tipoffMs = new Date(selectedGame.tipoffIso).getTime();
    if (!Number.isFinite(tipoffMs)) return null;
    const eventStartSec = Math.floor(tipoffMs / 1000);
    const { bettingCloseTime, closeTime } = sportsTimestamps(eventStartSec, 'basketball');
    return {
      bettingCloseSec: Number(bettingCloseTime),
      closeSec: Number(closeTime),
      bettingCloseTime,
      closeTime,
    };
  }, [selectedGame]);

  const closeTooSoon = timestamps !== null && timestamps.bettingCloseSec <= nowSec;
  const tooFarOut =
    timestamps !== null && timestamps.closeSec - nowSec > MAX_DURATION_SEC;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/discover/basketball', { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setFetchError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as DiscoverBasketballResponse;
        if (cancelled) return;
        setGames(data.games ?? []);
        if (data.error) setFetchError(data.error);
      } catch (e) {
        if (!cancelled) setFetchError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalNumber = useMemo(() => {
    const n = Number(totalInput);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [totalInput]);

  const isTotalQ = questionType === 'over' || questionType === 'under';

  const autoQuestion = useMemo(() => {
    if (!selectedGame) return '';
    const { homeTeam, visitorTeam } = selectedGame;
    switch (questionType) {
      case 'home_win':
        return `Will ${homeTeam} beat ${visitorTeam}?`;
      case 'away_win':
        return `Will ${visitorTeam} beat ${homeTeam}?`;
      case 'over':
        return `Over ${totalNumber} total points in ${visitorTeam} @ ${homeTeam}?`;
      case 'under':
        return `Under ${totalNumber} total points in ${visitorTeam} @ ${homeTeam}?`;
    }
  }, [selectedGame, questionType, totalNumber]);

  const oracleRefStr = useMemo(() => {
    if (!selectedGame) return '';
    const param = isTotalQ ? String(totalNumber) : '0';
    return `${selectedGame.id}:${questionType}:${param}`;
  }, [selectedGame, questionType, totalNumber, isTotalQ]);

  const oracleRefTooLong = useMemo(() => {
    if (!oracleRefStr) return false;
    return new TextEncoder().encode(oracleRefStr).length > 32;
  }, [oracleRefStr]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !selectedGame ||
      isBusy ||
      oracleRefTooLong ||
      (isTotalQ && totalNumber <= 0) ||
      timestamps === null ||
      tooFarOut ||
      drifted
    ) {
      return;
    }

    const submitNowSec = Math.floor(Date.now() / 1000);
    const validation = validateMarketTimestamps({
      nowSec: submitNowSec,
      bettingCloseTime: timestamps.bettingCloseTime,
      closeTime: timestamps.closeTime,
      strictBettingBeforeClose: true,
    });
    if (validation) {
      console.error('[create-basketball] validation failed:', validation);
      return;
    }

    const creatorSeed = parseCreatorSeed(seedInput);
    if (creatorSeed === null) return;

    const oracleRef = toBytes32(oracleRefStr);

    await onSubmit({
      mType: MarketType.BASKETBALL,
      oracleRef,
      bettingCloseTime: timestamps.bettingCloseTime,
      closeTime: timestamps.closeTime,
      question: autoQuestion,
      creatorSeed,
      creatorYes: side === 'yes',
    });
  };

  const disabled =
    isBusy ||
    !selectedGame ||
    oracleRefTooLong ||
    (isTotalQ && totalNumber <= 0) ||
    closeTooSoon ||
    tooFarOut ||
    drifted ||
    dailyCapHit ||
    parseCreatorSeed(seedInput) === null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col">
      <div className="border-b-2 border-ink">
        <div className="px-6 py-3 flex justify-between items-center bg-surface-elevated">
          <span className="mako-label text-muted">UPCOMING * NBA * NEXT 7 DAYS</span>
          <span className="mako-label text-subtle">TAP TO SELECT</span>
        </div>
        {games === null ? (
          <div className="py-12 text-center mako-label text-muted border-t-2 border-ink">
            LOADING GAMES...
          </div>
        ) : games.length === 0 ? (
          <div className="py-12 text-center border-t-2 border-ink px-6">
            <div className="mako-label text-muted mb-3">NO GAMES AVAILABLE</div>
            {fetchError && (
              <div className="mako-label text-[10px] text-subtle break-words max-w-xs mx-auto leading-relaxed">
                {fetchError.slice(0, 180)}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col divide-y-2 divide-ink border-t-2 border-ink">
            {games.map((g) => {
              const isSelected = selectedGame?.id === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setSelectedGame(g)}
                  disabled={isBusy}
                  className={`py-4 px-6 flex flex-col items-start text-left transition-colors disabled:opacity-50 ${
                    isSelected
                      ? 'bg-ink text-paper'
                      : 'bg-paper hover:bg-surface-elevated'
                  }`}
                >
                  <span className="mako-title text-base leading-tight">
                    {g.visitorTeam} @ {g.homeTeam}
                  </span>
                  <span
                    className={`mako-label mt-1 ${
                      isSelected ? 'text-paper/70' : 'text-muted'
                    }`}
                  >
                    TIPOFF * {g.tipoffLabel}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">QUESTION TYPE</label>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              { key: 'home_win' as const, label: 'HOME WIN' },
              { key: 'away_win' as const, label: 'AWAY WIN' },
              { key: 'over' as const, label: 'OVER TOTAL' },
              { key: 'under' as const, label: 'UNDER TOTAL' },
            ]
          ).map(({ key, label }) => {
            const isActive = questionType === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setQuestionType(key)}
                disabled={isBusy}
                aria-pressed={isActive}
                className={`py-3 mako-label rounded-xl border-2 border-ink transition-all disabled:opacity-50 ${
                  isActive
                    ? 'bg-ink text-paper shadow-[4px_4px_0_0_#D94A3D] -translate-y-[2px] -translate-x-[2px]'
                    : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {isTotalQ && (
        <div className="px-6 py-5 border-b-2 border-ink">
          <label htmlFor="nba-total" className="mako-label text-muted mb-3 block">
            TOTAL POINTS LINE
          </label>
          <div className="flex items-center gap-3 border-2 border-ink rounded-xl px-4 py-3 bg-paper">
            <input
              id="nba-total"
              type="text"
              inputMode="decimal"
              value={totalInput}
              onChange={(e) => setTotalInput(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={isBusy}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none mako-display text-2xl tabular-nums disabled:opacity-50"
              placeholder="215.5"
            />
            <span className="mako-label text-muted">PTS</span>
          </div>
          <div className="mako-label text-muted mt-2">
            NBA AVERAGE IS ~220 * ADJUST FOR MATCHUP PACE
          </div>
        </div>
      )}

      {/* Betting window -- derived from tipoff, NOT user-picked. */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">BETTING WINDOW</label>
        {selectedGame && timestamps !== null ? (
          <div>
            <div className="mako-display text-base tabular-nums">
              BETS CLOSE * {new Date(timestamps.bettingCloseSec * 1000).toUTCString().replace(' GMT', ' UTC')}
            </div>
            <div
              className={`mako-label mt-1 ${
                closeTooSoon ? 'text-mako-red' : 'text-muted'
              }`}
            >
              {closeTooSoon
                ? 'TIPOFF TOO SOON * PICK A LATER GAME'
                : tooFarOut
                  ? 'EVENT TOO FAR OUT * MARKETS SETTLE WITHIN 7 DAYS'
                  : `${humanizeUntil(timestamps.bettingCloseSec - nowSec)} * RESOLVES ~${Math.round(BASKETBALL_DURATION_SEC / 60)} MIN AFTER TIPOFF`}
            </div>
          </div>
        ) : (
          <div className="mako-label text-subtle">
            SELECT A GAME TO SEE CLOSE TIME
          </div>
        )}
      </div>

      <div className="px-6 py-5 border-b-2 border-ink bg-surface-elevated">
        <label className="mako-label text-muted mb-2 block">
          QUESTION (AUTO-GENERATED)
        </label>
        <p className="mako-title text-lg leading-tight">
          {autoQuestion || '-'}
        </p>
        {oracleRefTooLong && (
          <p className="mako-label text-mako-red mt-2">
            ORACLE REF TOO LONG * PICK A SHORTER TOTAL
          </p>
        )}
      </div>

      <CreatorSeedBlock
        seedInput={seedInput}
        setSeedInput={setSeedInput}
        side={side}
        setSide={setSide}
        isBusy={isBusy}
      />

      <button
        type="submit"
        disabled={disabled}
        className={`w-full py-5 mako-display text-lg uppercase tracking-tight transition-colors ${
          disabled
            ? 'bg-surface-elevated text-muted cursor-not-allowed'
            : 'bg-signal text-ink hover:bg-signal/90'
        }`}
      >
        {isBusy ? statusText ?? '...' : 'CREATE NBA MARKET'}
      </button>
    </form>
  );
}

// ======================================================================
// PRICE-FEED TAB -- generic strike/direction/duration form for FOREX,
// COMMODITIES, and STOCKS. Same on-chain shape as CRYPTO (the contract
// just distinguishes them via mType for downstream oracle routing).
// Symbols come from the price-feed allowlist (src/lib/price-feed-assets);
// the cf-worker resolves outcomes via Pyth Hermes (#180). Live price
// grid per asset class is deferred to a follow-up phase.
// ======================================================================

type PriceFeedKind = 'forex' | 'commodities' | 'stocks';

type PriceFeedTabProps = TabProps & { kind: PriceFeedKind };

const PRICE_FEED_COPY: Record<PriceFeedKind, {
  mType: MarketType;
  label: string;
  symbolLabel: string;
  strikeLabel: string;
  /// Used only as a fallback if the allowlist is somehow empty at
  /// render time; the runtime default is `getAssetsByClass(kind)[0]`.
  defaultSymbol: string;
  defaultStrike: string;
  questionVerb: string;
}> = {
  forex: {
    mType: MarketType.FOREX,
    label: 'FX',
    symbolLabel: 'PAIR',
    strikeLabel: 'STRIKE RATE',
    defaultSymbol: 'EURUSD',
    defaultStrike: '1.08',
    questionVerb: 'trade',
  },
  commodities: {
    mType: MarketType.COMMODITIES,
    label: 'COMMODITY',
    symbolLabel: 'ASSET',
    strikeLabel: 'STRIKE PRICE (USD)',
    defaultSymbol: 'XAUUSD',
    defaultStrike: '2400',
    questionVerb: 'settle',
  },
  stocks: {
    mType: MarketType.STOCKS,
    label: 'STOCK',
    symbolLabel: 'TICKER',
    strikeLabel: 'STRIKE PRICE (USD)',
    defaultSymbol: 'AAPL',
    defaultStrike: '200',
    questionVerb: 'close',
  },
};

function PriceFeedTab({ kind, onSubmit, isBusy, statusText, drifted, dailyCapHit }: PriceFeedTabProps) {
  const copy = PRICE_FEED_COPY[kind];
  // #180: symbol comes from the price-feed allowlist (closed set per
  // class). Default to the first asset by priority (the canonical
  // "most liquid" entry). The PRICE_FEED_COPY.defaultSymbol field
  // is now only a fallback for the rare case where the allowlist
  // gets reordered without a re-render; the runtime source of truth
  // is `assets[0]`.
  const assets = useMemo(() => getAssetsByClass(kind), [kind]);
  const [symbol, setSymbol] = useState(assets[0]?.symbol ?? copy.defaultSymbol);
  const [direction, setDirection] = useState<Direction>('above');
  const [strikeInput, setStrikeInput] = useState(copy.defaultStrike);
  const [durationSec, setDurationSec] = useState(3600);
  const [seedInput, setSeedInput] = useState(formatUsdc(MIN_CREATOR_SEED_USDC_BASE));
  const [side, setSide] = useState<'yes' | 'no'>('yes');

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(id);
  }, []);

  const normalizedSymbol = symbol.trim().toUpperCase();
  const strikeNumber = useMemo(() => {
    const n = Number(strikeInput);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [strikeInput]);

  const closeTimeSec = nowSec + durationSec;
  const bettingCloseSec = useMemo(
    () => Number(suggestedCryptoBettingCloseTimeMirror(nowSec, closeTimeSec)),
    [nowSec, closeTimeSec],
  );

  const oracleRefStr = useMemo(() => {
    if (!normalizedSymbol || strikeNumber <= 0) return '';
    const op = direction === 'above' ? 'gt' : 'lt';
    return `${normalizedSymbol}:${op}:${strikeNumber}`;
  }, [normalizedSymbol, direction, strikeNumber]);

  const oracleRefTooLong = useMemo(() => {
    if (!oracleRefStr) return false;
    return new TextEncoder().encode(oracleRefStr).length > 32;
  }, [oracleRefStr]);

  const autoQuestion = useMemo(() => {
    if (!normalizedSymbol || strikeNumber <= 0) return '';
    const durationLabel =
      DURATIONS.find((d) => d.seconds === durationSec)?.label ?? `${durationSec}s`;
    const dirWord = direction === 'above' ? 'above' : 'below';
    return `Will ${normalizedSymbol} ${copy.questionVerb} ${dirWord} ${strikeNumber} in ${durationLabel}?`;
  }, [normalizedSymbol, direction, strikeNumber, durationSec, copy.questionVerb]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!normalizedSymbol || strikeNumber <= 0 || oracleRefTooLong || isBusy || drifted) return;

    const submitNowSec = Math.floor(Date.now() / 1000);
    const submitCloseSec =
      submitNowSec +
      Math.min(
        durationSec + TX_LANDING_BUFFER_SEC,
        MAX_DURATION_SEC - TX_LANDING_BUFFER_SEC,
      );
    const submitBettingCloseSec = Number(
      suggestedCryptoBettingCloseTimeMirror(submitNowSec, submitCloseSec),
    );

    const closeTime = BigInt(submitCloseSec);
    const bettingCloseTime = BigInt(submitBettingCloseSec);

    const validation = validateMarketTimestamps({
      nowSec: submitNowSec,
      bettingCloseTime,
      closeTime,
    });
    if (validation) {
      console.error(`[create-${kind}] validation failed:`, validation);
      return;
    }

    const creatorSeed = parseCreatorSeed(seedInput);
    if (creatorSeed === null) return;

    const oracleRef = toBytes32(oracleRefStr);

    await onSubmit({
      mType: copy.mType,
      oracleRef,
      bettingCloseTime,
      closeTime,
      question: autoQuestion,
      creatorSeed,
      creatorYes: side === 'yes',
    });
  };

  const disabled =
    isBusy
    || !normalizedSymbol
    || strikeNumber <= 0
    || oracleRefTooLong
    || drifted
    || dailyCapHit
    || parseCreatorSeed(seedInput) === null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col">
      {/* Symbol */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label htmlFor="pf-symbol" className="mako-label text-muted mb-3 block">
          {copy.symbolLabel}
        </label>
        <div className="flex items-center gap-3 border-2 border-ink rounded-xl px-4 py-3 bg-paper">
          <select
            id="pf-symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            disabled={isBusy}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none mako-display text-2xl uppercase tabular-nums disabled:opacity-50 cursor-pointer"
          >
            {assets.map((a) => (
              <option key={a.symbol} value={a.symbol}>
                {a.symbol} — {a.label}
              </option>
            ))}
          </select>
        </div>
        {kind === 'stocks' ? (
          <div className="mako-label text-muted mt-2">
            US market hours: NYSE / NASDAQ. Off-hours markets settle
            against last-traded price.
          </div>
        ) : null}
      </div>

      {/* Direction */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">DIRECTION</label>
        <div className="grid grid-cols-2 gap-3">
          {(['above', 'below'] as const).map((dir) => {
            const isActive = direction === dir;
            return (
              <button
                key={dir}
                type="button"
                onClick={() => setDirection(dir)}
                disabled={isBusy}
                aria-pressed={isActive}
                className={`py-3 mako-label rounded-xl border-2 border-ink transition-all disabled:opacity-50 ${
                  isActive
                    ? 'bg-ink text-paper shadow-brutal-red -translate-y-[2px] -translate-x-[2px]'
                    : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
                }`}
              >
                {dir === 'above' ? 'UP / ABOVE' : 'DN / BELOW'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Strike */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label htmlFor="pf-strike" className="mako-label text-muted mb-3 block">
          {copy.strikeLabel}
        </label>
        <div className="flex items-center gap-3 border-2 border-ink rounded-xl px-4 py-3 bg-paper">
          <input
            id="pf-strike"
            type="text"
            inputMode="decimal"
            value={strikeInput}
            onChange={(e) => setStrikeInput(e.target.value.replace(/[^0-9.]/g, ''))}
            disabled={isBusy}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none mako-display text-2xl tabular-nums disabled:opacity-50"
            placeholder={copy.defaultStrike}
          />
        </div>
      </div>

      {/* Duration */}
      <div className="px-6 py-5 border-b-2 border-ink">
        <label className="mako-label text-muted mb-3 block">DURATION</label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {DURATIONS.map((d) => {
            const isActive = durationSec === d.seconds;
            return (
              <button
                key={d.seconds}
                type="button"
                onClick={() => setDurationSec(d.seconds)}
                disabled={isBusy}
                aria-pressed={isActive}
                className={`py-2.5 mako-label rounded-lg border-2 border-ink transition-all disabled:opacity-50 tabular-nums ${
                  isActive
                    ? 'bg-ink text-paper shadow-brutal-red -translate-y-[1px] -translate-x-[1px]'
                    : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px]'
                }`}
              >
                {d.short}
              </button>
            );
          })}
        </div>
        <div className="mako-label text-muted mt-3 leading-relaxed">
          BETS CLOSE {humanizeUntil(bettingCloseSec - nowSec).toUpperCase()} * RESOLVES {humanizeUntil(closeTimeSec - nowSec).toUpperCase()}
        </div>
      </div>

      {/* Auto-question */}
      <div className="px-6 py-5 border-b-2 border-ink bg-surface-elevated">
        <label className="mako-label text-muted mb-2 block">QUESTION (AUTO-GENERATED)</label>
        <p className="mako-title text-lg leading-tight">{autoQuestion || '-'}</p>
        {oracleRefTooLong && (
          <p className="mako-label text-mako-red mt-2">
            ORACLE REF TOO LONG ({oracleRefStr.length} BYTES) * MAX 32 * PICK SHORTER SYMBOL OR STRIKE
          </p>
        )}
        <p className="mako-label text-subtle text-[10px] mt-2 leading-relaxed">
          {copy.label} markets resolve automatically via Pyth Hermes at close time.
        </p>
      </div>

      <CreatorSeedBlock
        seedInput={seedInput}
        setSeedInput={setSeedInput}
        side={side}
        setSide={setSide}
        isBusy={isBusy}
      />

      <button
        type="submit"
        disabled={disabled}
        className={`w-full py-5 mako-display text-lg uppercase tracking-tight transition-colors ${
          disabled
            ? 'bg-surface-elevated text-muted cursor-not-allowed'
            : 'bg-signal text-ink hover:bg-signal/90'
        }`}
      >
        {isBusy ? statusText ?? '...' : `CREATE ${copy.label} MARKET`}
      </button>
    </form>
  );
}
