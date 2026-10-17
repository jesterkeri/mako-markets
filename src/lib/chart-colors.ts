// Candle colours on Mako's charts (Joshua 2026-10-17): TradingView's full set (body, border and wick, each for a rising
// and a falling candle), TradingView's own green and red by default, and each signed-in user's choice saved to their
// account (users.chart_colors, migration 0018, via /api/user/chart-colors).

export type ChartColors = {
  upBody: string;
  downBody: string;
  upBorder: string;
  downBorder: string;
  upWick: string;
  downWick: string;
};

export const CHART_COLOR_KEYS = ['upBody', 'downBody', 'upBorder', 'downBorder', 'upWick', 'downWick'] as const;

const TV_GREEN = '#26a69a';
const TV_RED = '#ef5350';

/// TradingView's defaults: green rising and red falling, body, border and wick alike.
export const DEFAULT_CHART_COLORS: ChartColors = {
  upBody: TV_GREEN,
  downBody: TV_RED,
  upBorder: TV_GREEN,
  downBorder: TV_RED,
  upWick: TV_GREEN,
  downWick: TV_RED,
};

const HEX = /^#[0-9a-f]{6}$/;

/// A stored or submitted value, exactly the six keys as lower-case #rrggbb; null for anything else.
export function parseChartColors(raw: unknown): ChartColors | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length !== CHART_COLOR_KEYS.length) return null;
  const out = {} as ChartColors;
  for (const k of CHART_COLOR_KEYS) {
    const v = o[k];
    if (typeof v !== 'string' || !HEX.test(v.toLowerCase())) return null;
    out[k] = v.toLowerCase();
  }
  return out;
}
