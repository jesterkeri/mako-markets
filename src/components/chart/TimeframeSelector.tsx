// ----------------------------------------------------------------------------
// src/components/chart/TimeframeSelector.tsx
//
// Rounded-pill segmented control. Sits in the chart card header strip
// next to the instrument label. Active button swaps to ink/paper; the
// whole group is a single pill that visually rhymes with the YES/NO
// probability bar and admin RESOLVE row on the same page.
//
// `role="tab"` + `aria-selected` preserved so the RTL test in
// `market-chart-component.test.tsx` ('1D' tab query) keeps passing.
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
  '2h':  '2H',
  '4h':  '4H',
  '1d':  '1D',
};

export function TimeframeSelector({ value, onChange, options }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Chart timeframe"
      className="inline-flex items-stretch rounded-full border-2 border-ink overflow-hidden bg-paper"
    >
      {options.map((tf, idx) => {
        const active = value === tf;
        const notLast = idx < options.length - 1;
        return (
          <button
            key={tf}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tf)}
            className={[
              'mako-label text-[11px] tracking-widest px-3.5 py-1.5 min-w-[44px]',
              'transition-colors',
              notLast ? 'border-r-2 border-ink' : '',
              active
                ? 'bg-ink text-paper'
                : 'bg-paper text-ink hover:bg-ink/5',
            ].join(' ')}
          >
            {LABEL[tf]}
          </button>
        );
      })}
    </div>
  );
}
