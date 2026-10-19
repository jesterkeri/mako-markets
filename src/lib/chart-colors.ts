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

/// A colour as stored: #rrggbb, lower-cased; null for anything else.
const toHex = (v: unknown): string | null => (typeof v === 'string' && HEX.test(v.toLowerCase()) ? v.toLowerCase() : null);

/// A stored or submitted value, exactly the six keys as lower-case #rrggbb; null for anything else.
export function parseChartColors(raw: unknown): ChartColors | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length !== CHART_COLOR_KEYS.length) return null;
  const out = {} as ChartColors;
  for (const k of CHART_COLOR_KEYS) {
    const v = toHex(o[k]);
    if (!v) return null;
    out[k] = v;
  }
  return out;
}

/// A submitted change: one to six of the keys, each a #rrggbb (lower-cased); null for anything else (an unknown or
/// empty key set, a bad colour). Saves send only what changed, and the server merges it into what it holds, so a change
/// in one tab never puts another tab's stale colours back (adversary r10 on 2d48a79).
export function parseChartColorPatch(raw: unknown): Partial<ChartColors> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  const out: Partial<ChartColors> = {};
  for (const [k, v] of entries) {
    const hex = toHex(v);
    if (!(CHART_COLOR_KEYS as readonly string[]).includes(k) || !hex) return null;
    out[k as keyof ChartColors] = hex;
  }
  return out;
}

/// The set a change produces over what is held (TradingView's defaults when nothing is): the server's merge, and the
/// browser's optimistic copy of it.
export const mergeChartColors = (held: ChartColors | null, patch: Partial<ChartColors>): ChartColors => ({ ...(held ?? DEFAULT_CHART_COLORS), ...patch });
