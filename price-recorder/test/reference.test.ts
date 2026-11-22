// CHARTS_DS_PLAN 15.4: an independent Python implementation (scripts/reference_ohlc.py, its own ABI slicing and its
// own rules) computed every minute of every vendored capture; the TypeScript builder must agree exactly. CI re-runs
// the script with --check, so the committed reference cannot drift from it.
import { describe, expect, it } from 'vitest';

import reference from './fixtures/reference-ohlc.json';
import { buildMinute } from '../src/candle';
import { capture, feed } from './helpers';

type Ref = { file: string; symbol: string; t: number; state: string; o?: string; h?: string; l?: string; c?: string; n_reports?: number; n_open?: number; open_obs?: number; close_obs?: number; max_stale_s?: number | null };

describe('TypeScript candles equal the independent Python reference, minute for minute', () => {
  const refs = reference as Ref[];
  it('covers every vendored capture and every state they hold', () => {
    expect(refs.length).toBe(26);
    expect(new Set(refs.map((r) => r.state))).toEqual(new Set(['open', 'closed', 'incomplete']));
  });
  for (const r of refs)
    it(`${r.file} ${r.symbol} ${new Date(r.t * 1000).toISOString().slice(0, 16)}: ${r.state}`, () => {
      const name = r.file.replace('capture-2026-10-16/', '').replace('.json', '');
      const row = buildMinute(feed(r.symbol), r.t, capture(name));
      expect(row.state).toBe(r.state);
      if (r.state === 'incomplete') return;
      const pick = (x: Record<string, unknown>) => ({ o: x.o ?? null, h: x.h ?? null, l: x.l ?? null, c: x.c ?? null, n_reports: x.n_reports, n_open: x.n_open ?? 0, open_obs: x.open_obs ?? null, close_obs: x.close_obs ?? null, max_stale_s: x.max_stale_s ?? null });
      expect(pick(row)).toEqual(pick(r as unknown as Record<string, unknown>));
    });
});
