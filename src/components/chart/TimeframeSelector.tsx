// ----------------------------------------------------------------------------
// src/components/chart/TimeframeSelector.tsx
//
// Neobrutalist 4-button row. Ported from krait
// `apps/web/src/components/chart/TimeframeSelector.tsx` with:
//   - Re-typed against mako's `Timeframe` ('15m'|'1h'|'4h'|'1d')
//     rather than krait's M1/M5/H1/D1 enum
//   - `options` prop so commodity markets can pass `['1d']` only
//   - Inline-style hex → mako brand classes (border-ink etc.)
//
// Plan: %TEMP%/mako-166-charts-plan.md  Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

'use client';

import type { Timeframe } from '@/types/chart';

interface Props {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
  options: readonly Timeframe[];
}

const LABEL: Record<Timeframe, string> = {
  '15m': '15M',
  '1h':  '1H',
  '4h':  '4H',
  '1d':  '1D',
};

export function TimeframeSelector({ value, onChange, options }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Chart timeframe"
      className="flex gap-0 border-b-2 border-ink"
    >
      {options.map((tf) => {
        const active = value === tf;
        return (
          <button
            key={tf}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tf)}
            className={[
              'mako-label px-3 py-2 text-xs border-r-2 border-ink last:border-r-0',
              'transition-colors',
              active
                ? 'bg-ink text-paper'
                : 'bg-paper text-ink hover:bg-surface-elevated',
            ].join(' ')}
          >
            {LABEL[tf]}
          </button>
        );
      })}
    </div>
  );
}
