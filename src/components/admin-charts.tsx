'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// Recharts' TooltipContentProps generic is strict about value types
// (<number, string> conflicts with its own internal ValueType); the
// payload shape we actually use is stable, so we lean on a narrow
// local shape rather than chasing the library's generics.
type TooltipProps = {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
};

/**
 * Recharts-backed admin charts. Both components use `currentColor` for
 * stroke/fill so Tailwind's text-foreground token cascades through —
 * keeps the visual voice tied to the rest of the admin UI (brutalist,
 * monochrome, sharp edges) rather than importing a chart theme.
 *
 * Styling choices:
 *  - No vertical gridlines (they fight with the bar/area silhouette)
 *  - Horizontal gridlines at 10% opacity for scale reference
 *  - Ticks in the same font-black uppercase tracking-widest voice as
 *    every other label in the admin surface
 *  - Tooltip is a plain black rectangle — no Recharts default chrome
 */

type DauDatum = { dateISO: string; wallets: number; bets: number };
type GrowthDatum = { dateISO: string; cumulativeUsers: number; newUsers: number };

const AXIS_TICK = {
  fill: 'currentColor',
  fontSize: 9,
  fontWeight: 900,
  letterSpacing: '0.1em',
} as const;

function formatTickDate(dateISO: string): string {
  // UTC YYYY-MM-DD → MM-DD in ticks to save horizontal space.
  return dateISO.slice(5);
}

export function DauChart({ data }: { data: DauDatum[] }) {
  return (
    <div className="h-36">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="dateISO"
            tickFormatter={formatTickDate}
            tick={AXIS_TICK}
            tickLine={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
            axisLine={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={32}
          />
          <Tooltip
            cursor={{ fill: 'currentColor', fillOpacity: 0.08 }}
            content={(props) => <DauTooltip {...props} />}
          />
          <Bar
            dataKey="wallets"
            fill="currentColor"
            isAnimationActive
            animationDuration={600}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function DauTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as DauDatum;
  return (
    <div className="bg-black text-background px-3 py-2 text-[10px] font-black uppercase tracking-widest border border-black">
      <div className="text-background/70">{d.dateISO}</div>
      <div className="mt-1 tabular-nums">
        {d.wallets} WALLET{d.wallets === 1 ? '' : 'S'} · {d.bets} BET{d.bets === 1 ? '' : 'S'}
      </div>
    </div>
  );
}

export function UserGrowthChart({ data }: { data: GrowthDatum[] }) {
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="mako-user-growth-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.35} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="dateISO"
            tickFormatter={formatTickDate}
            tick={AXIS_TICK}
            tickLine={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
            axisLine={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={32}
          />
          <Tooltip
            cursor={{ stroke: 'currentColor', strokeOpacity: 0.3, strokeDasharray: '2 2' }}
            content={(props) => <GrowthTooltip {...props} />}
          />
          <Area
            type="monotone"
            dataKey="cumulativeUsers"
            stroke="currentColor"
            strokeWidth={1.5}
            fill="url(#mako-user-growth-fill)"
            isAnimationActive
            animationDuration={800}
            activeDot={{ r: 3, fill: 'currentColor', stroke: 'none' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function GrowthTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as GrowthDatum;
  return (
    <div className="bg-black text-background px-3 py-2 text-[10px] font-black uppercase tracking-widest border border-black">
      <div className="text-background/70">{d.dateISO}</div>
      <div className="mt-1 tabular-nums">
        TOTAL {d.cumulativeUsers} · +{d.newUsers} NEW
      </div>
    </div>
  );
}
