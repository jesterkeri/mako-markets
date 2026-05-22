// ----------------------------------------------------------------------------
// src/components/chart/ChartTooltip.tsx
//
// Generic value-tooltip primitive. Ported from krait
// `apps/web/src/components/ui/ChartTooltip.tsx`, restyled to mako
// neobrutalist (cream paper / ink border / mako-red for negative).
//
// NOTE: lightweight-charts provides its own crosshair tooltip; this
// component is NOT wired into ChartInner in v1. It's exported here
// for parity with the plan and as a primitive for follow-ups (e.g.
// a custom OHLC-on-hover popup driven by chart.subscribeCrosshairMove).
//
// Plan: %TEMP%/mako-166-charts-plan.md  Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

interface ChartTooltipProps {
  active?: boolean;
  label?: string;
  format?: (v: number) => string;
  payload?: { value: number }[];
}

export function ChartTooltip({ active, label, payload, format }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const val = payload[0]!.value;
  const formatted = format ? format(val) : `${val >= 0 ? '+' : ''}$${val.toFixed(2)}`;
  const positive = val >= 0;

  return (
    <div className="border-2 border-ink bg-paper px-2 py-1 mako-label text-[11px]">
      {label && <div className="text-muted text-[9px] mb-0.5">{label}</div>}
      <div className={positive ? 'text-ink font-semibold' : 'text-mako-red font-semibold'}>
        {formatted}
      </div>
    </div>
  );
}
