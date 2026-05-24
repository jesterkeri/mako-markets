// ----------------------------------------------------------------------------
// src/components/AssetSelect.tsx
//
// Custom dropdown for FOREX / COMMODITIES / STOCKS asset pickers on
// /create. Replaces the browser-native <select>, which was both off-
// brand (no neobrutal styling) and couldn't show live prices alongside
// each option.
//
// Prices come from Pyth Hermes via useHermesPrices — same source the
// cf-worker uses for resolution, so what the user sees in the
// dropdown is what their market will settle against.
// ----------------------------------------------------------------------------

'use client';

import { useEffect, useRef, useState } from 'react';
import { useHermesPrices } from '@/lib/use-hermes-prices';
import type { PriceFeedAsset } from '@/lib/price-feed-assets';

interface Props {
  id?: string;
  value: string;
  onChange: (symbol: string) => void;
  options: readonly PriceFeedAsset[];
  disabled?: boolean;
}

function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(5);
}

export function AssetSelect({ id, value, onChange, options, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const ids = options.map((o) => o.pythPriceId);
  const { data: prices } = useHermesPrices(ids);

  const selected = options.find((o) => o.symbol === value) ?? options[0];

  // Outside click / ESC close.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 border-2 border-ink rounded-xl px-4 py-3 bg-paper hover:bg-surface-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-left"
      >
        <div className="flex flex-col min-w-0">
          <span className="mako-display text-2xl uppercase tabular-nums truncate">
            {selected?.symbol}
          </span>
          <span className="mako-label text-[10px] text-muted truncate">
            {selected?.label}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {selected && prices?.[selected.pythPriceId.toLowerCase()] && (
            <span className="mako-mono tabular-nums text-base text-ink">
              {formatPrice(prices[selected.pythPriceId.toLowerCase()].price)}
            </span>
          )}
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter"
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 bg-paper border-2 border-ink rounded-xl shadow-brutal max-h-[320px] overflow-y-auto no-scrollbar"
        >
          <div className="flex items-center justify-between px-4 py-2 border-b-2 border-ink bg-surface-elevated mako-label text-[9px] tracking-widest text-muted">
            <span>SYMBOL</span>
            <span>LIVE PRICE · PYTH</span>
          </div>
          {options.map((opt) => {
            const live = prices?.[opt.pythPriceId.toLowerCase()];
            const active = opt.symbol === value;
            return (
              <button
                key={opt.symbol}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(opt.symbol);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 border-b-2 border-ink/10 last:border-b-0 text-left transition-colors ${
                  active
                    ? 'bg-ink text-paper'
                    : 'bg-paper text-ink hover:bg-surface-elevated'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`mako-display text-base tabular-nums w-20 shrink-0 ${active ? 'text-paper' : 'text-ink'}`}>
                    {opt.symbol}
                  </span>
                  <span className={`mako-body text-sm truncate ${active ? 'text-paper/70' : 'text-muted'}`}>
                    {opt.label}
                  </span>
                </div>
                <span className={`mako-mono tabular-nums text-sm shrink-0 ${active ? 'text-paper' : 'text-ink'}`}>
                  {live ? formatPrice(live.price) : '—'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
