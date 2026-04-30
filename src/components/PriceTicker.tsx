'use client';

import { useEffect, useState } from 'react';
import { CRYPTO_ASSETS, formatPriceUsd, type CryptoSymbol } from '@/lib/crypto-assets';

/**
 * News-channel-style bottom price crawl. Fixed to the bottom of the
 * viewport, right-to-left, seamless loop (content rendered twice).
 *
 * Polls `/api/discover/crypto` every 10s. That route is already server-
 * cached for ~10s, so real lag is up to 20s. Fine for a prediction-market
 * context (not HFT).
 *
 * Which assets render is driven entirely by src/lib/crypto-assets.ts —
 * add a symbol there and it shows up here automatically.
 *
 * Accessibility:
 *  - `role="marquee"` + `aria-live="off"` so screen readers don't shout
 *    prices every tick.
 *  - Hover pauses the crawl so users can read a specific row.
 *  - `prefers-reduced-motion: reduce` halts the animation entirely.
 *
 * The crawl animation itself is pure CSS (see globals.css `.ticker-crawl`).
 * We only duplicate the item list here — no JS-driven scroll.
 */

type CoinPrice = { usd: number; change24h: number; testnet?: boolean };
type Prices = Partial<Record<CryptoSymbol, CoinPrice>>;

function formatPct(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function TickerItem({ label, price }: { label: string; price: CoinPrice }) {
  const up = price.change24h > 0;
  const down = price.change24h < 0;
  const arrow = up ? '↑' : down ? '↓' : '·';
  const deltaClass = up ? 'text-chrome-fg' : down ? 'text-warning' : 'text-subtle';
  return (
    <div className="flex items-baseline gap-2 px-6 border-r border-chrome-divider shrink-0 tabular-nums">
      <span className="text-[10px] font-black uppercase tracking-widest text-chrome-fg/60">
        {label}
      </span>
      <span className="text-sm font-black text-chrome-fg">{formatPriceUsd(price.usd)}</span>
      {price.testnet ? (
        <span className="text-[10px] font-black uppercase tracking-widest text-chrome-fg/40">
          TESTNET
        </span>
      ) : (
        <span className={`text-[10px] font-black uppercase tracking-widest ${deltaClass}`}>
          {arrow} {formatPct(price.change24h)}
        </span>
      )}
    </div>
  );
}

export function PriceTicker() {
  const [prices, setPrices] = useState<Prices | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/discover/crypto', { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { prices?: Prices; error?: string };
        if (cancelled) return;
        setPrices(data.prices ?? {});
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Fixed-bottom strip, black background, high-contrast like a TV ticker.
  // Slim height (h-9) keeps it out of the way on both mobile and desktop.
  // `pointer-events: none` on the outer lets clicks through except where
  // the inner track re-enables them, so hover-to-pause still works but a
  // stray click on the strip won't block the content behind it.
  const wrapperBase =
    'fixed bottom-0 left-0 right-0 z-40 h-9 bg-chrome overflow-hidden border-t border-chrome-divider';

  if (error && !prices) {
    return (
      <div className={wrapperBase}>
        <div className="h-full flex items-center px-6 text-[10px] font-black uppercase tracking-widest text-chrome-fg/70">
          PRICES UNAVAILABLE
        </div>
      </div>
    );
  }

  if (!prices) {
    return (
      <div className={wrapperBase}>
        <div className="h-full flex items-center px-6 text-[10px] font-black uppercase tracking-widest text-chrome-fg/50">
          LOADING PRICES…
        </div>
      </div>
    );
  }

  // Render the items twice back-to-back so the crawl loops seamlessly.
  // The CSS animation translates the track from 0 to -50%, at which point
  // copy #2 has slid into copy #1's starting position.
  const sortedAssets = [...CRYPTO_ASSETS].sort((a, b) => a.priority - b.priority);
  const items = sortedAssets.flatMap((asset) => {
    const p = prices[asset.symbol];
    return p ? [<TickerItem key={asset.symbol} label={asset.symbol} price={p} />] : [];
  });

  return (
    <div
      className={wrapperBase}
      role="marquee"
      aria-live="off"
      aria-label="Live crypto prices"
    >
      <div className="h-full flex items-center ticker-crawl whitespace-nowrap">
        <div className="flex items-center shrink-0">{items}</div>
        <div className="flex items-center shrink-0" aria-hidden>
          {items}
        </div>
      </div>
    </div>
  );
}
